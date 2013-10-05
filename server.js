require('longjohn');

var formidable = require('formidable'),
http = require('http'),
util = require('util'),
File = require('formidable/lib/file'),
fs = require('fs'),
spawn = require('child_process').spawn,
log = console.log;

var TIME_LIMIT = 1000 * 60 * 60 * 24; //one day

function generateFileName(){
  var name = '';
  for (var i = 0; i < 32; i++) {
    name += Math.floor(Math.random() * 16).toString(16);
  }
  return name;
}

function now(){
  return new Date().getTime();
}

http.createServer(function(req, res) {
  if (req.url == '/upload' && req.method.toLowerCase() == 'post') {
    //reference to the stream of uploaded file data being piped into ffmpeg
    var uploadedFileStream = null;

    //reference to the file being uploaded
    var theFile = null;

    //used for signaling state
    var uploadComplete = false;
    var transcodeComplete = false;
    var timeLimitExceeded = false;

    //    var preset = "veryslow";
    var preset = "ultrafast";
    var encodedPath = "/Users/albrooksfan/uploads/trans/test.mp4";

    //used to determine what sections of the file to stream to ffmpeg
    var bytesWritten = 0;
    var bytesLoaded = 0;

    var ffmpeg = spawn("ffmpeg", ["-y", "-i", "-", "-acodec", "libfaac", "-ab", "128k", "-ac", "2", "-vcodec", "libx264", "-preset", preset, "-crf", "22", "-threads", "0", encodedPath]);

    //closes input to ffmpeg if it's still open
    function cleanupFFMPEG(){
      if(ffmpeg.stdin.writable){
        log("ffmpeg stdin ended");
        ffmpeg.stdin.end();
      }
    }

    ffmpeg.stderr.on("data", function(data) {
      if (data != null){
        //TODO: determine if errors are happening and  handle them
        //log("ffmpeg ERROR " + data);
        log("ffmpeg error " + data.length);
      }
    });

    ffmpeg.stdin.on("close", function() {
      log("ffmpeg stdin closed");
    });

    ffmpeg.stdin.on("error", function(err) {
      //this seems to happen sometimes when ffmpeg decides to exit on bad input
      //but hasn't yet emitted the exit event
      log("ffmpeg stdin error");
    });

    ffmpeg.on("exit", function(code) {
      //deactivate the timeLimitTimeout
      clearTimeout(timeLimitTimeout);

      //set this so if the upload ends after ffmpeg is already dead it knows
      //there was a problem
      transcodeComplete = true;

      //if ffmpeg exited due to an error then stdin will need to be closed
      cleanupFFMPEG();

      if(timeLimitExceeded){
        //TODO: delete the transcoded file
        log("ffmpeg timed out, delete the transcoded file");

        if(uploadComplete){
          //TODO: move the file to transcoding watch folder
          log("move the file to transcoding watch folder");
        }

      } else {
        //ffmpeg can exit successfully even if the upload was canceled, so ensure
        //that the upload completed before trusting this
        if(uploadComplete){
          if(code == 0){
            //TODO: move the original file and the transcoded file to a finished folder
            log("ffmpeg exited successfully, move the original file and the transcoded file to a finished folder");

          } else {
            //TODO: delete the transcoded file, then move the original file to a
            //transcoding watch directory
            log("ffmpeg exited with error, delete the transcoded file, then move the original file to a transcoding watch directory");
          }

        } else {
          //TODO: delete the transcoded file
          log("ffmpeg exited early, delete the transcoded file");
        }
      }
    });

    function pumpFileToFFMPEG(written, loaded){
      if(!ffmpeg.stdin.writable){
        log("stdin is closed, no longer pumping");
        return;
      }

      log("piping " + written + " to " + loaded + " from " + theFile.path);

      uploadedFileStream = fs.createReadStream(theFile.path, {
        //start is 0 indexed and end is inclusive, so we cut it
        //one byte short
        start: written,
        end: loaded - 1
      });

      //update this so the next call to pumpFileToFFMPEG picks up where this one
      //ends
      bytesWritten = loaded;

      uploadedFileStream.on("error", function(err){
        //this normally shouldn't happen
        log("cleanup ffmpeg after piping error");
        cleanupFFMPEG();
      });

      uploadedFileStream.on("end", function(){
        log("finished piping "+ written + " to " + loaded + " from " + theFile.path);

        //NOTE: even though uploadComplete would be false if the upload was
        //canceled, this won't recurse forever, because the uploadedFileStream
        //is destroyed (on upload error), which stops the 'end' event from ever
        //being emitted
        if(uploadComplete && bytesWritten >= bytesLoaded){
          log("cleanup ffmpeg after piping ended");
          cleanupFFMPEG();
        } else {
          //TODO: turn this into a loop, and make sure it sleeps while waiting for more input


          //note: this could theoretically blow out the stack
          pumpFileToFFMPEG(bytesWritten, bytesLoaded);
        }
      });

      //'end: false' indicates that we dont want the pipe to close stdin when it
      //finishes, which is important since the piping will likely have to happen
      //a few times before all is finished
      uploadedFileStream.pipe(ffmpeg.stdin, {
        end: false
      });
    }

    var timeLimitTimeout = setTimeout(function(){
      timeLimitExceeded = true;

      log("time limit exceeded for " + theFile.path);

      if(uploadedFileStream !== null){
        log("uploadedFileStream destroyed");
        uploadedFileStream.destroy();
      }

      cleanupFFMPEG();

    //TODO: delete the transcode, then move the original file to a problem folder

    }, TIME_LIMIT);

    // parse a file upload
    var form = new formidable.IncomingForm();

    form.uploadDir = "/Users/albrooksfan/uploads";

    form.on('progress', function(bytesReceived, bytesExpected) {
      //TODO: store this in redis or something
      //log("progress " + bytesReceived + "\t" + bytesExpected);
      });

    form.on('fileBegin', function(name, file) {
      log("fileBegin " + file.path);

      theFile = file;

      var pumpingStarted = false;

      file.on('progress', function(size) {
        bytesLoaded = size;

        if(!pumpingStarted){
          pumpingStarted = true;
          //pump pieces of the written file to ffmpegs stdin
          pumpFileToFFMPEG(bytesWritten, bytesLoaded);
        }
      });
    });

    form.on('end', function() {
      //deactivate the timeLimitTimeout
      clearTimeout(timeLimitTimeout);

      log("upload completed", theFile.path);
      uploadComplete = true;

      //if the transcoding already exited, the file either needs special
      //processing or is junk
      if(transcodeComplete){
        //TODO: move the file to the transcoding watch directory
        log("file must need special processing")
        log("move the file to the transcoding watch directory")
      }
    });

    form.on('error', function() {
      //deactivate the timeLimitTimeout
      clearTimeout(timeLimitTimeout);

      log("upload error", theFile.path);

      if(uploadedFileStream !== null){
        log("uploadedFileStream destroyed");
        uploadedFileStream.destroy();
      }

      //close ffmpeg
      cleanupFFMPEG();
    });

    form.on('aborted', function() {
      //we don't cleanup ffmpeg here because the error event will also fire and
      //take care of it
      log("upload aborted", theFile.path);
    });

    try{
      //begin parsing the upload
      form.parse(req, function(err, fields, files) {
        if(err){
          log("uploaded form parse error", err);
          return;
        }

        res.writeHead(200, {
          'content-type': 'text/plain'
        });
        res.write('received upload:\n\n');
        res.end();
      });
    } catch(exception){
      log("bad post exception: ", exception);
    }

    return;
  }

  //show a file upload form
  res.writeHead(200, {
    'content-type': 'text/html'
  });
  res.end(
    '<form action="/upload" enctype="multipart/form-data" method="post">'+
    '<input type="text" name="title"><br>'+
    '<input type="file" name="upload" multiple="multiple"><br>'+
    '<input type="submit" value="Upload">'+
    '</form>'
    );
}).listen(8080);

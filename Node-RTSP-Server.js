//DEPENDENCIES
const express = require('express');
const child = require('child_process');
const events = require('events');
const cors = require('cors'); //To prevent Google Chrome CORS error
const WebSocket = require('ws');
const onvif = require('node-onvif');
const axios = require('axios');
let serverPORT; //node server port. This server will start all the ffmpeg processes as in when requests arrive.
const DennisIP = process.argv[2];
const DennisPort = process.argv[3];
let nodeServer;
let ALL_CONNECTED_ONVIF_CAMERA_DETAILS = [];
let moveX, moveY; //how much the PTZ camera moves;
let INTERVAL_TIMER = undefined;


//http://192.168.100.67:80/onvif/device_service

// will hold list of active ffmpeg processes
let activeFfmpegProcesses = [];
let cameraList = [];
let temp = undefined;

// Initialize Express app
const app = express();
const Emitter = new events.EventEmitter().setMaxListeners(1);

// Middleware
app.use(express.json());
app.use(cors());

const NODE_STARTER = () => {
    axios.get(`http://${DennisIP}:${DennisPort}/config`)
    .then(res => {
      let temp = res.data;
      serverPORT = temp.node_server_port;
      moveX = parseFloat(temp.camera_control_step_size_x);
      moveY = parseFloat(temp.camera_control_step_size_y);
      nodeServer = app.listen(serverPORT, () => {
        console.log(`Server running on port ${serverPORT}`);
      }).on('error', (err) => {
        console.log(`APP.LISTEN ERROR: ${err}`);
      })
      clearInterval(INTERVAL_TIMER);
    })
    .catch(err => {
      console.warn(`ERROR STARTING NODE SERVER: ${err}`);
      process.on('uncaughtException', () => {
        process.kill('SIGINT');
      })
    });
  }


try
{
    onvif.startProbe().then((devices) => {
        devices.forEach((info) => {
            ALL_CONNECTED_ONVIF_CAMERA_DETAILS.push(info.xaddrs[0]);
        })
        console.log(ALL_CONNECTED_ONVIF_CAMERA_DETAILS);
    }).catch((err) => {
        console.error(`Error while probing for ONVIF cameras: ${err}`);
    })
}
catch(err)
{
    console.log(err);
}




//----------------IF Dennis or BACKEND is NOT running, then use this code------------//
// app.listen(10001, () => {
//     console.log('server running on port 10001');
// })
//-----------------------------------------------------------------------------------//

//--------------IF Dennis or BACKEND IS running, then use this code-----------------//
    INTERVAL_TIMER = setInterval(() => {
      if(serverPORT !== undefined)
      {
        return;
      }
      else {
        NODE_STARTER();
      }
    }, 1000);
    
//------------------------------------------------------------------------------------//







// Handle all requests for live streaming
app.post('/rtsp-config', (req, res) => {
    temp = `${req.body.name}_${req.body.url}_${req.body.wsPort}`;
    if(cameraList.length === 0)
    {
        cameraList.push(temp);
        res.status(201).send('Got the camera configurations successfully')
    }
    else if(cameraList.length > 0)
    {
        if(!cameraList.includes(temp))
        {
            cameraList.push(temp);
            res.status(201).send('Got the camera configuration successfully')
        } 
        else if(cameraList.includes(temp)) 
        {
            res.status(200).send('This entry already exists in the server');
        }
    }
    Emitter.emit('rtsp-start');
});


//Start FFMPEG encoder 
Emitter.on('rtsp-start', (req, res) => {
    if(activeFfmpegProcesses.length === 0 && cameraList.length > 0)
    {
        cameraList.forEach((camdata) => {
            const ffmpegString = `-rtsp_transport tcp -i ${camdata.split("_")[1]} -f mpegts -an -q 4 -c:v mpeg1video -b:v 1M -r 30 -`;
            const ffmpegProcess = child.spawn('ffmpeg', ffmpegString.split(" "));
            let temp = camdata.split('_')[1].split('@'); //IP address like 192.168.100.168 etc
            let temp2 = temp[0].substring(7, temp[0].length + 1) //user:password
            let username = temp2.split(':')[0];
            let password = temp2.split(':')[1];
            let onvif_camera;
            let profile;
            console.log(camdata)
            // Start websocket server for this camera feed--------------------------
            const socketServer = new WebSocket.Server({ port: camdata.split("_")[2] });
            socketServer.connectionCount = 0;
            socketServer.broadcast = (stream) => {
                socketServer.clients.forEach((client) => {
                    if(client.readyState === WebSocket.OPEN)
                    {
                        client.send(stream);
                    }
                })
            }

            socketServer.on('connection', (socket) => {
                socketServer.connectionCount++;
                console.log(`New socket connected to websocket server at port ${camdata.split("_")[2]}`);
                console.log(`Total connected socket: ${socketServer.connectionCount}`);
                
                socket.on('message', (msg) => {
                    if(msg === 'Initiate Onvif Device')
                    {
                        // ALL_CONNECTED_ONVIF_CAMERA_DETAILS.forEach((info) => {
                        //     if(info.includes(temp[1].split(':')[0]))
                        //     {
                        //         onvif_camera = new onvif.OnvifDevice({
                        //             xaddr: info,
                        //             user: username,
                        //             pass: password
                        //         })

                        //         onvif_camera.init().then(() => {
                        //             profile = onvif_camera.getCurrentProfile();
                        //             console.log('Successfully initialized new ONVIF camera object');
                        //             socket.send('Onvif Initialization Successful');
                        //         }).catch(() => {
                        //             console.log('Error during initialization of new ONVIF camera');
                        //         })
                        //     }
                        // })
                        onvif_camera = new onvif.OnvifDevice({
                            xaddr: `http://${temp[1].split(':')[0]}/onvif/device_service`,
                            user: username,
                            pass: password
                        })

                        onvif_camera.init().then(() => {
                            profile = onvif_camera.getCurrentProfile();
                            console.log('Successfully initialized new ONVIF camera object');
                            socket.send('Onvif Initialization Successful');
                        }).catch(() => {
                            console.log('Error during initialization of new ONVIF camera');
                        })
                    }
                    if(msg === 'Up-Button')
                    {

                        try
                        {
                            let params = {
                            'ProfileToken': `${profile['token']}`,
                            'Translation': { 'x': 0.0, 'y': moveY, 'z': 0.0 },
                            'Speed': { 'x': 1, 'y': 1, 'z': 1 }
                            }
                            if(onvif_camera.services.ptz !== null)
                            {
                                onvif_camera.services.ptz.relativeMove(params)
                                .then((result) => { JSON.stringify(result['data'], null, ' ') })
                                .catch((err) => { console.error(`Error during PTZ move: ${err}`) });
                            }
                        }
                        catch(err)
                        {
                            console.error(`ERROR: ${err}`);
                        }
                    }

                    if(msg === 'Down-Button')
                    {
                        
                        try
                        {
                            let params = {
                            'ProfileToken': `${profile['token']}`,
                            'Translation': { 'x': 0.0, 'y': -moveY, 'z': 0.0 },
                            'Speed': { 'x': 1, 'y': 1, 'z': 1 }
                            }
                            if(onvif_camera.services.ptz !== null)
                            {
                                onvif_camera.services.ptz.relativeMove(params)
                                .then((result) => { JSON.stringify(result['data'], null, ' ') })
                                .catch((err) => { console.error(`Error during PTZ move: ${err}`) });
                            }
                        }
                        catch(err)
                        {
                            console.error(`ERROR: ${err}`);
                        }
                    }

                    if(msg === 'Left-Button')
                    {
                        
                        try
                        {
                            let params = {
                            'ProfileToken': `${profile['token']}`,
                            'Translation': { 'x': -moveX, 'y': 0.0, 'z': 0.0 },
                            'Speed': { 'x': 1, 'y': 1, 'z': 1 }
                            }
                            if(onvif_camera.services.ptz !== null)
                            {
                                onvif_camera.services.ptz.relativeMove(params)
                                .then((result) => { JSON.stringify(result['data'], null, ' ') })
                                .catch((err) => { console.error(`Error during PTZ move: ${err}`) });
                            }
                        }
                        catch(err)
                        {
                            console.error(`ERROR: ${err}`);
                        }
                    }
                    if(msg === 'Right-Button')
                    {
                        
                        try
                        {
                            let params = {
                                'ProfileToken': `${profile['token']}`,
                                'Translation': { 'x': moveX, 'y': 0.0, 'z': 0.0 },
                                'Speed': { 'x': 1, 'y': 1, 'z': 1 }
                            }
                            if(onvif_camera.services.ptz !== null)
                            {
                                onvif_camera.services.ptz.relativeMove(params)
                                .then((result) => { JSON.stringify(result['data'], null, ' ') })
                                .catch((err) => { console.error(`Error during PTZ move: ${err}`) });
                            }
                        }
                        catch(err)
                        {
                            console.error(`ERROR: ${err}`);
                        }
                    }
                    if(msg === 'Zoom-Plus')
                    {
                        
                        try
                        {
                            let params = {
                                'ProfileToken': `${profile['token']}`,
                                'Translation': { 'x': 0.0, 'y': 0.0, 'z': 0.1 },
                                'Speed': { 'x': 1, 'y': 1, 'z': 1 }
                            }
                            if(onvif_camera.services.ptz !== null)
                            {
                                onvif_camera.services.ptz.relativeMove(params)
                                .then((result) => { JSON.stringify(result['data'], null, ' ') })
                                .catch((err) => { console.error(`Error during PTZ move: ${err}`) });
                            }
                        }
                        catch(err)
                        {
                            console.error(`ERROR: ${err}`);
                        }
                    }
                    if(msg === 'Zoom-Minus')
                    {
                        
                        try
                        {
                            let params = {
                                'ProfileToken': `${profile['token']}`,
                                'Translation': { 'x': 0.0, 'y': 0.0, 'z': -0.1 },
                                'Speed': { 'x': 1, 'y': 1, 'z': 1 }
                            }
                            if(onvif_camera.services.ptz !== null)
                            {
                                onvif_camera.services.ptz.relativeMove(params)
                                .then((result) => { JSON.stringify(result['data'], null, ' ') })
                                .catch((err) => { console.error(`Error during PTZ move: ${err}`) });
                            }
                        }
                        catch(err)
                        {
                            console.error(`ERROR: ${err}`);
                        }
                    }

                })
                
                socket.on('close', () => {
                    socketServer.connectionCount--;
                    console.log(`Socket disconnected from websocket server at port ${camdata.split("_")[2]}`);
                    console.log(`Total connected sockets after disconnect: ${socketServer.connectionCount}`)
                    if(socketServer.connectionCount === 0)
                    {
                        socketServer.close();
                        ffmpegProcess.kill('SIGINT');
                        activeFfmpegProcesses.splice(activeFfmpegProcesses.indexOf(camdata.split("_")[1]), 1);
                        cameraList.splice(cameraList.indexOf(camdata), 1);
                    }
                })
            })

            //-------------------------------------------------------------------------

            ffmpegProcess.stdout.on('data', (stream) => {
                socketServer.broadcast(stream);
            })

            ffmpegProcess.stderr.on('data', (stream) => {
                socketServer.broadcast(stream);
            });

            activeFfmpegProcesses.push(camdata.split("_")[1]);
        })
    }
    else if(activeFfmpegProcesses.length > 0 && cameraList.length > 0)
    {
        cameraList.forEach((camdata) => {
            if(!activeFfmpegProcesses.includes(camdata.split("_")[1]))
            {
                const ffmpegString = `-rtsp_transport tcp -i ${camdata.split("_")[1]} -f mpegts -an -q 4 -c:v mpeg1video -b:v 1M -r 30 -`;
                const ffmpegProcess = child.spawn('ffmpeg', ffmpegString.split(" "));
                let temp = camdata.split('_')[1].split('@'); //IP address like 192.168.100.168 etc
                let temp2 = temp[0].substring(7, temp[0].length + 1) //user:password
                let username = temp2.split(':')[0];
                let password = temp2.split(':')[1];
                let onvif_camera;
                let profile;
                // Websocket server for the particular camera started--------------------------
                const socketServer = new WebSocket.Server({ port: camdata.split("_")[2] });
                socketServer.connectionCount = 0;
                socketServer.broadcast = (stream) => {
                    socketServer.clients.forEach((client) => {
                        if(client.readyState === WebSocket.OPEN)
                        {
                            client.send(stream);
                        }
                    })
                }

                socketServer.on('connection', (socket) => {
                    socketServer.connectionCount++;
                    console.log(`New socket connected to websocket server at port ${camdata.split("_")[2]}`);
                    console.log(`Total connected socket: ${socketServer.connectionCount}`);
                    
                    socket.on('message', (msg) => {
                        if(msg === 'Initiate Onvif Device')
                        {
                            // ALL_CONNECTED_ONVIF_CAMERA_DETAILS.forEach((info) => {
                            //     if(info.includes(temp[1].split(':')[0]))
                            //     {
                            //         onvif_camera = new onvif.OnvifDevice({
                            //             xaddr: info,
                            //             user: username,
                            //             pass: password
                            //         })
    
                            //         onvif_camera.init().then(() => {
                            //             profile = onvif_camera.getCurrentProfile();
                            //             console.log('Successfully initialized new ONVIF camera object');
                            //             socket.send('Onvif Initialization Successful');
                            //         }).catch(() => {
                            //             console.log('Error during initialization of new ONVIF camera');
                            //         })
                            //     }
                            // })
                            onvif_camera = new onvif.OnvifDevice({
                                xaddr: `http://${temp[1].split(':')[0]}/onvif/device_service`,
                                user: username,
                                pass: password
                            })

                            onvif_camera.init().then(() => {
                                profile = onvif_camera.getCurrentProfile();
                                console.log('Successfully initialized new ONVIF camera object');
                                socket.send('Onvif Initialization Successful');
                            }).catch(() => {
                                console.log('Error during initialization of new ONVIF camera');
                            })
                        }
                        if(msg === 'Up-Button')
                        {
    
                            try
                            {
                                let params = {
                                    'ProfileToken': `${profile['token']}`,
                                    'Translation': { 'x': 0.0, 'y': moveY, 'z': 0.0 },
                                    'Speed': { 'x': 1, 'y': 1, 'z': 1 }
                                }
                                if(onvif_camera.services.ptz !== null)
                                {
                                    onvif_camera.services.ptz.relativeMove(params)
                                    .then((result) => { JSON.stringify(result['data'], null, ' ') })
                                    .catch((err) => { console.error(`Error during PTZ move: ${err}`) });
                                }
                            }
                            catch(err)
                            {
                                console.error(`ERROR: ${err}`);
                            }
                        }
    
                        if(msg === 'Down-Button')
                        {
                            
                            try
                            {
                                let params = {
                                    'ProfileToken': `${profile['token']}`,
                                    'Translation': { 'x': 0.0, 'y': -moveY, 'z': 0.0 },
                                    'Speed': { 'x': 1, 'y': 1, 'z': 1 }
                                }
                                if(onvif_camera.services.ptz !== null)
                                {
                                    onvif_camera.services.ptz.relativeMove(params)
                                    .then((result) => { JSON.stringify(result['data'], null, ' ') })
                                    .catch((err) => { console.error(`Error during PTZ move: ${err}`) });
                                }
                            }
                            catch(err)
                            {
                                console.error(`ERROR: ${err}`);
                            }
                        }
    
                        if(msg === 'Left-Button')
                        {
                            
                            try
                            {
                                let params = {
                                    'ProfileToken': `${profile['token']}`,
                                    'Translation': { 'x': -moveX, 'y': 0.0, 'z': 0.0 },
                                    'Speed': { 'x': 1, 'y': 1, 'z': 1 }
                                }
                                if(onvif_camera.services.ptz !== null)
                                {
                                    onvif_camera.services.ptz.relativeMove(params)
                                    .then((result) => { JSON.stringify(result['data'], null, ' ') })
                                    .catch((err) => { console.error(`Error during PTZ move: ${err}`) });
                                }
                            }
                            catch(err)
                            {
                                console.error(`ERROR: ${err}`);
                            }
                        }
                        if(msg === 'Right-Button')
                        {
                            
                            try
                            {
                                let params = {
                                    'ProfileToken': `${profile['token']}`,
                                    'Translation': { 'x': moveX, 'y': 0.0, 'z': 0.0 },
                                    'Speed': { 'x': 1, 'y': 1, 'z': 1 }
                                }
                                if(onvif_camera.services.ptz !== null)
                                {
                                    onvif_camera.services.ptz.relativeMove(params)
                                    .then((result) => { JSON.stringify(result['data'], null, ' ') })
                                    .catch((err) => { console.error(`Error during PTZ move: ${err}`) });
                                }
                            }
                            catch(err)
                            {
                                console.error(`ERROR: ${err}`);
                            }
                        }
                        if(msg === 'Zoom-Plus')
                        {
                            
                            try
                            {
                                let params = {
                                    'ProfileToken': `${profile['token']}`,
                                    'Translation': { 'x': 0.0, 'y': 0.0, 'z': 0.1 },
                                    'Speed': { 'x': 1, 'y': 1, 'z': 1 }
                                }
                                if(onvif_camera.services.ptz !== null)
                                {
                                    onvif_camera.services.ptz.relativeMove(params)
                                    .then((result) => { JSON.stringify(result['data'], null, ' ') })
                                    .catch((err) => { console.error(`Error during PTZ move: ${err}`) });
                                }
                            }
                            catch(err)
                            {
                                console.error(`ERROR: ${err}`);
                            }
                        }
                        if(msg === 'Zoom-Minus')
                        {
                            
                            try
                            {
                                let params = {
                                    'ProfileToken': `${profile['token']}`,
                                    'Translation': { 'x': 0.0, 'y': 0.0, 'z': -0.1 },
                                    'Speed': { 'x': 1, 'y': 1, 'z': 1 }
                                }
                                if(onvif_camera.services.ptz !== null)
                                {
                                    onvif_camera.services.ptz.relativeMove(params)
                                    .then((result) => { JSON.stringify(result['data'], null, ' ') })
                                    .catch((err) => { console.error(`Error during PTZ move: ${err}`) });
                                }
                            }
                            catch(err)
                            {
                                console.error(`ERROR: ${err}`);
                            }
                        }
    
                    })
                    
                    socket.on('close', () => {
                        socketServer.connectionCount--;
                        console.log(`Socket disconnected from websocket server at port ${camdata.split("_")[2]}`);
                        console.log(`Total sockets after disconnect: ${socketServer.connectionCount}`)

                        if(socketServer.connectionCount === 0)
                        {
                            socketServer.close();
                            ffmpegProcess.kill('SIGINT');
                            activeFfmpegProcesses.splice(activeFfmpegProcesses.indexOf(camdata.split("_")[1]), 1);
                            cameraList.splice(cameraList.indexOf(camdata), 1);
                        }
                    })
                })
                //------------------------------------------------------------------------------

                ffmpegProcess.stdout.on('data', (stream) => {
                    socketServer.broadcast(stream);
                })

                ffmpegProcess.stderr.on('error', () => {
                    console.log(`Some error occurred in process with id ${ffmpegProcess.pid}`);
                })

                activeFfmpegProcesses.push(camdata.split("_")[1]);

            }
        })
    }

});

// To check which all processes are still going on the backend, calculates load
// setInterval(() => {
//     console.log(activeFfmpegProcesses);
// }, 2000);

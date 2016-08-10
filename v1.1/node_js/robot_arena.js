// Math.TAU polyfill. TAU equal 2 times PI.
if (!Math.TAU) { Math.TAU = 2.0 * Math.PI; }

var express = require("express");
var app = express();
var http = require("http").Server(app);
var io = require("socket.io")(http);

var arena = {
	size: { x: 750, y: 750 },
	currentTime: (new Date()).getTime(),
	numOfConnections: 0,
	scoreBoard: {},
	users: {},
	robots: [],
	missiles: [],
	frameRate: 30
};

// Each parameter need to be objects with an X and Y number value.
// Like: { x:0, y:0 }
function distanceSqr (position1, position2) {
	return (
		(position1.x - position2.x) * (position1.x - position2.x) +
		(position1.y - position2.y) * (position1.y - position2.y)
	);
}

// Main update loop for all action taking place in the arena.  Broadcast new actions only to arena viewers.
function arenaUpdate() {
	arena.currentTime = (new Date()).getTime();
	arena.numOfConnections = Object.keys(io.sockets.sockets).length;
	//console.log("Connections: " + Object.keys(io.sockets.sockets).length);
	
	// Handle created non-player objects.
	arena.missiles.forEach(function(missile, index) {
		missile.position.x += Math.cos(missile.heading) * (missile.speed / arena.frameRate);
		missile.position.y += Math.sin(missile.heading) * (missile.speed / arena.frameRate);
		missile.distanceSqr = distanceSqr(missile.startPoint, missile.position);

		// If missle goes out of arena it is gone no explosion. (yet)
		if (missile.position.x < 0 || missile.position.x > arena.size.x ||
			missile.position.y < 0 || missile.position.y > arena.size.y
		) { arena.missiles.splice(index, 1); }
		
		if (missile.distanceSqr > (missile.range * missile.range)) {
			// Handle explosion, and then remove missle from list.
			arena.robots.forEach(function(robot, index){
				if (robot.dead) return;
				var dist_M2R_Sqr = distanceSqr(robot.position, missile.position);
				
				if (dist_M2R_Sqr <= 2500) {
					robot.damage += ((2500 - dist_M2R_Sqr) / 250);
				}
				
				if (robot.damage >= 100) {
					if (!arena.scoreBoard[(robot.name)]) {
						arena.scoreBoard[(robot.name)] = {};
						arena.scoreBoard[(robot.name)].kills = 0;
						arena.scoreBoard[(robot.name)].deaths = 0;
					}
					arena.scoreBoard[arena.robots[arena.users[missile.ownerId].robotIndex].name].kills++;
				}
			});
			
			arena.missiles.splice(index, 1);
		}
	});
	
	arena.robots.forEach(function(robot, index) {
		robot.robotIndex = index;
		robot.arenaCurrentTime = (new Date()).getTime();
		
		if (!robot.dead) {
			if (robot.damage >= 100) {
				robot.damage = 100;
				robot.dead = true;
				if (!arena.scoreBoard[(robot.name)]) {
					arena.scoreBoard[(robot.name)] = {};
					arena.scoreBoard[(robot.name)].kills = 0;
					arena.scoreBoard[(robot.name)].deaths = 0;
				}
				arena.scoreBoard[(robot.name)].deaths++;
			} else {
				robot.damage -= 0.005;
				if (robot.damage < 0) robot.damage = 0;
			}
			robot.position.x += Math.cos(robot.heading) * (robot.speed / arena.frameRate);
			robot.position.y += Math.sin(robot.heading) * (robot.speed / arena.frameRate);
			if (robot.position.x < 0)            { robot.position.x = 0;            robot.speed = 0; }
			if (robot.position.x > arena.size.x) { robot.position.x = arena.size.x; robot.speed = 0; }
			if (robot.position.y < 0)            { robot.position.y = 0;            robot.speed = 0; }
			if (robot.position.y > arena.size.y) { robot.position.y = arena.size.y; robot.speed = 0; }
			
		}

		if (arena.users[robot.socketId]) {
			liveArena.to(robot.socketId).emit("robotStatus", robot);
		} else {
			arena.robots.splice(index, 1);
		}
	});
	
	for(var socketId in arena.users) {
		if (arena.currentTime - arena.users[socketId].ping > 60000) {
			userDisconnet(socketId, "forced_disconnect");
			continue;
		}
		if (typeof arena.users[socketId].type == "undefined") continue;
		
		if (arena.users[socketId].type == "arenaViewer") {
			// Only arenaViewers should be allowed some of this detailed information.
			liveArena.to(socketId).emit("users", arena );
		}
	}
}

function fireCannon(socket, angle, range) {
	if (!arena.users[socket.id]) return; // If user doesn't exist yet, then there is nothing to do.
	if (!arena.robots[arena.users[socket.id].robotIndex]) return; // If there is no robot we can't take action.
	if (arena.robots[arena.users[socket.id].robotIndex].dead) return; // No actions for dead robots.

	if ((arena.robots[arena.users[socket.id].robotIndex].arenaCurrentTime - arena.robots[arena.users[socket.id].robotIndex].lastFired)
		< ((1000 / arena.frameRate) * 6)) return; // Don't fire too fast.
	
	// Correct values out of range.
	if (angle < (Math.TAU * -10)) angle = 0;
	if (angle < 0) angle += (Math.TAU * 10);
	angle %= Math.TAU;
	
	if (range < 1) range = 1;
	//console.log("socketId(" + socket.id + ") firing at angle: " + angle + ", and range: " + range);
	
	arena.missiles.push({
		ownerId: socket.id,
		startPoint: { x: arena.robots[arena.users[socket.id].robotIndex].position.x, y: arena.robots[arena.users[socket.id].robotIndex].position.y },
		position:   { x: arena.robots[arena.users[socket.id].robotIndex].position.x, y: arena.robots[arena.users[socket.id].robotIndex].position.y },
		range: range,
		heading: angle,
		speed: 500
	});
	
	arena.robots[arena.users[socket.id].robotIndex].lastFired = (new Date()).getTime();
}

function setDrive(socket, angle, speed) {
	if (!arena.users[socket.id]) return; // If user doesn't exist yet, then there is nothing to do.
	if (!arena.robots[arena.users[socket.id].robotIndex]) return; // If there is no robot we can't take action.
	if (arena.robots[arena.users[socket.id].robotIndex].dead) return; // No actions for dead robots.
	
	if ((arena.robots[arena.users[socket.id].robotIndex].arenaCurrentTime - arena.robots[arena.users[socket.id].robotIndex].lastSetDrive)
		< ((1000 / arena.frameRate) * 3)) return; // Don't change too fast.
	
	// Correct values out of range.
	if (angle < (Math.TAU * -10)) angle = 0;
	if (angle < 0) angle += (Math.TAU * 10);
	angle %= Math.TAU;
	
	if (speed < 0) speed = 0;
	if (speed > 100) speed = 100;
	//console.log("socketId(" + socket.id + ") set drive at angle: " + angle + ", and speed: " + speed);
	
	if (typeof angle == "number") arena.robots[arena.users[socket.id].robotIndex].heading = angle;
	if (typeof speed == "number") arena.robots[arena.users[socket.id].robotIndex].speed = speed;
	
	arena.robots[arena.users[socket.id].robotIndex].lastSetDrive = (new Date()).getTime();
}

function checkScanner(socket, angle, arc) {
	if (!arena.users[socket.id]) return; // If user doesn't exist yet, then there is nothing to do.
	if (!arena.robots[arena.users[socket.id].robotIndex]) return; // If there is no robot we can't take action.
	if (arena.robots[arena.users[socket.id].robotIndex].dead) return; // No actions for dead robots.
	
	if ((arena.robots[arena.users[socket.id].robotIndex].arenaCurrentTime - arena.robots[arena.users[socket.id].robotIndex].lastScanned)
		< ((1000 / arena.frameRate) * 2)) return; // Don't scan too fast.
	
	// Correct values out of range.
	if (angle < (Math.TAU * -10)) angle = 0;
	if (angle < 0) angle += (Math.TAU * 10);
	angle %= Math.TAU;
	
	if (arc < 0.02) arc = 0.02; // 0.02 radians is roughly close to 1 degree.  I figure an arc should never be smaller than that.
	if (arc > Math.TAU) arc = Math.TAU;
	//console.log("socketId(" + socket.id + ") check scanner at angle: " + angle + ", and arc:" + arc);
	
	arena.robots[arena.users[socket.id].robotIndex].scanInfo.found = false;
	arena.robots[arena.users[socket.id].robotIndex].scanInfo.angle = angle;
	arena.robots[arena.users[socket.id].robotIndex].scanInfo.arc = arc;
	arena.robots[arena.users[socket.id].robotIndex].scanInfo.target = [];
	arena.robots.forEach(function(robot, index) {
		if (robot.socketId != socket.id) {
			if (robot.dead) return;
			var distanceToTarget = Math.sqrt(distanceSqr(arena.robots[arena.users[socket.id].robotIndex].position, robot.position));
			if (distanceToTarget > 500) return; // Out of scanner range.
			
			var targetAngle = Math.atan2(
				robot.position.y - arena.robots[arena.users[socket.id].robotIndex].position.y,
				robot.position.x - arena.robots[arena.users[socket.id].robotIndex].position.x
			);
			targetAngle += Math.TAU;
			targetAngle %= Math.TAU;
			
			if ((targetAngle > (angle - Math.TAU - (arc / 2.0)) && targetAngle < (angle - Math.TAU + (arc / 2.0))) ||
				(targetAngle > (angle            - (arc / 2.0)) && targetAngle < (angle            + (arc / 2.0))) ||
				(targetAngle > (angle + Math.TAU - (arc / 2.0)) && targetAngle < (angle + Math.TAU + (arc / 2.0)))
			) {
				arena.robots[arena.users[socket.id].robotIndex].scanInfo.found = true;
				var foundSide = -1;
				if (
					(targetAngle > angle && targetAngle < (angle - Math.TAU + (arc / 2.0))) ||
					(targetAngle > angle && targetAngle < (angle            + (arc / 2.0))) ||
					(targetAngle > angle && targetAngle < (angle + Math.TAU + (arc / 2.0)))
				) { foundSide = 1; }
				arena.robots[arena.users[socket.id].robotIndex].scanInfo.target.push({
					type: "robot",
					name: robot.name,
					socketId: robot.socketId,
					distance: distanceToTarget,
					side: foundSide
				});
			}
		}
	});
	// Sort targets by distance with closest first and further away 
	arena.robots[arena.users[socket.id].robotIndex].scanInfo.target.sort(function(a, b) { return a.distance - b.distance; });
	
	liveArena.to(socket.id).emit("scanInfoUpdated", arena.robots[arena.users[socket.id].robotIndex].scanInfo);

	arena.robots[arena.users[socket.id].robotIndex].lastScanned = (new Date()).getTime();
}

// --- This should remain at the end ---------------------------------------------------------------------------------------
//socket.io
function userDisconnet(socketId, userName) {
	//console.log("socketId(" + socketId + ") disconnect user " + userName);
	if (arena.users[socketId]) if (arena.users[socketId].type == "robot") {
		//console.log("socketId(" + socketId + ") remove robot " + arena.robots[arena.users[socketId].robotIndex].name + "(" + (arena.users[socketId].robotIndex + 1) +")");
		arena.robots.splice(arena.users[socketId].robotIndex, 1);
		arena.robots.forEach(function(robot, index) { // Once we remove a robot we need to fix users robot indexes so they are correct again.
			arena.users[robot.socketId].robotIndex = index;
		});
	}
	delete arena.users[socketId];
}

var liveArena = io.of("/arena").on("connection", function(socket) {
	//console.info("socketId(" + socket.id + ") New client connected");
	if (!arena.users[socket.id]) {
		liveArena.to(socket.id).emit("notConnected", true);
	}
	
	// ----- Handling connection and creation of data per arena.users -----
	socket.on("connected", function(userName) {
		//console.log("socketId(" + socket.id + ") connect " + userName);
		arena.users[socket.id] = {};
		arena.users[socket.id].name = userName;
		arena.users[socket.id].ping = (new Date()).getTime();
		
		switch(userName) {
			case "arenaViewer":
				arena.users[socket.id].type = "arenaViewer";
				liveArena.to(socket.id).emit("users", arena);
				break;
			default:
				var newRobotIndex = arena.robots.push({
					robotIndex: -1,
					arenaCurrentTime: (new Date()).getTime(),
					name: userName,
					socketId: socket.id,
					position: { x: (Math.random() * arena.size.x), y: (Math.random() * arena.size.y) },
					heading: Math.random() * (Math.TAU),
					speed: 0,
					damage: 0,
					dead: false,
					scanInfo: { found: false, angle: -1, arc: -1, target: [] },
					lastFired: (new Date()).getTime(),
					lastScanned: (new Date()).getTime(),
					lastSetDrive: (new Date()).getTime()
				}) - 1;
				arena.robots[newRobotIndex].robotIndex = newRobotIndex;
				arena.users[socket.id].type = "robot";
				arena.users[socket.id].robotIndex = newRobotIndex;
				if (!arena.scoreBoard[(arena.robots[newRobotIndex].name)]) {
					arena.scoreBoard[(arena.robots[newRobotIndex].name)] = {};
					arena.scoreBoard[(arena.robots[newRobotIndex].name)].kills = 0;
					arena.scoreBoard[(arena.robots[newRobotIndex].name)].deaths = 0;
				}
		}
	});
	
	socket.on("connectionPing", function(data) {
		//console.log("socketId(" + socket.id + ") ping - " + data);
		if (arena.users[socket.id]) { arena.users[socket.id].ping = (new Date()).getTime(); }
	});
	
	socket.on("disconnected", function(userName) { userDisconnet(socket.id, userName) });

	// ----- Robot commands and/or response communications -----
	
	socket.on("fireCannon",   function(actionInfo) {   fireCannon(socket, actionInfo.angle, actionInfo.range); });
	socket.on("setDrive",     function(actionInfo) {     setDrive(socket, actionInfo.angle, actionInfo.speed); });
	socket.on("checkScanner", function(actionInfo) { checkScanner(socket, actionInfo.angle, actionInfo.arc  ); });
});

console.log("listening on 41337");
http.listen(41337);
setInterval(arenaUpdate, (1000 / arena.frameRate));
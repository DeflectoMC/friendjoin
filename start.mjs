#!/usr/bin/env node

import { RelayTCPHost } from "./RelayTCPHost.mjs";
import { RelayTCPClient } from "./RelayTCPClient.mjs";

import readline from "node:readline";
const commands = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

/**@type {RelayTCPHost | RelayTCPClient} */
let user;

function help() {
    console.log("", "===== FriendJoin =====");
    console.log("Commands:");
    console.log("/host - Host a game");
    console.log("/join id - Join a game");
    console.log("/ping - Pings the game");
    console.log("/quit - Quits the program");
    console.log("/clear - Clears the console");
}

commands.on("line", async line => {
    line = line.trim();
    if (line == "/clear") {
        console.clear();
        return;
    }
    if (line == "/ping") {
        if (!user) {
            console.log("You first need to host or join a game before pinging");
            return;
        }
        user.ping();
        return;
    }
    if (line == "/quit") {
        console.log("/quit");
        try {
            if (user) user.close();
        } catch (ex) {
            console.error(ex);
        }
        process.exit(0);
    }
    if (line == "/host") {
        if (user instanceof RelayTCPHost) {
            console.log("You are already hosting a game on this terminal window.");
            console.log("Open a new terminal if you need to host another one");
            return;
        } else if (user instanceof RelayTCPClient) {
            console.log("You are currently running a client on this terminal window.");
            console.log("Open a new terminal if you need to run a host");
            return;
        }
        const runningAServer = await RelayTCPHost.isPortInUse(25565);
        if (!runningAServer) {
            console.log("You'll need to start a multiplayer server before hosting.");
            console.log("If you are running a LAN world, that works too :) make sure to put 25565 as the port");
            return;
        }
        user = new RelayTCPHost();
        return;
    }
    if (line.startsWith("/join")) {
        if (user instanceof RelayTCPHost) {
            console.log("You are currently hosting a game on this terminal window.");
            console.log("Open a new terminal if you need to join a game");
            return;
        } else if (user instanceof RelayTCPClient) {
            console.log("You are already running a client on this terminal window.");
            console.log("Open a new terminal if you need to run another one");
            return;
        }
        let split = line.split(/\s+/);
        if (split.length <= 1 || split[1].length <= 0) {
            console.log("Usage: /join <server id>");
            return;
        }
        if (split[1].length != 10) {
            console.log("Invalid server ID: " + split[1]);
            return;
        }
        console.log("Joining " + split[1] + "...");
        user = new RelayTCPClient({ host_ID: split[1] });
        return;
    }
    help();
});

help();


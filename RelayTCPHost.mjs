import { WebSocket } from "ws";
import { PeerUtil } from "./PeerUtils.mjs";
import net, { Socket } from "node:net";

function log(message, extra) {
    if (!message) message = "";
    message = " " + message;
    const d = new Date();
    const prefix = `[${d.getUTCHours()}:${d.getUTCMinutes()}:${d.getUTCSeconds()}] [Host]`;
    if (extra) {
        console.log(`${prefix}${message}`, extra);
    } else {
        console.log(`${prefix}${message}`);
    }
}

function logError(message, extra) {
    if (!message) message = "";
    message = " " + message;
    const d = new Date();
    const prefix = `[${d.getUTCHours()}:${d.getUTCMinutes()}:${d.getUTCSeconds()}] [Host] [Error]`;
    if (extra) {
        console.error(`${prefix}${message}`, extra);
    } else {
        console.error(`${prefix}${message}`);
    }
}

/**Relays packets for a TCP host over WebRTC */
export class RelayTCPHost {

    #tcpPort = 25565
    #nexusConnection
    /**@type {Set<PeerUtil>} */
    #peers = new Set();
    /**@type {Set<Socket>} */
    #sockets = new Set();

    #debug = false;

    /**@param {boolean} isEnabled */
    setDebugEnabled(isEnabled) {
        this.#debug = !!isEnabled;
    }

    toggleDebug() {
        this.#debug = !this.#debug;
    }

    close() {
        if (this.#nexusConnection.readyState == WebSocket.OPEN) {
            log("Closing connection to Nexus");
            this.#nexusConnection.close();
        }
        this.#peers.forEach(peer => peer.close());
    }

    #pingCount = 0;

    ping() {
        let count = 0;
        for (let peer of this.#peers) {
            if (!peer.isEstablished() || peer.isClosed()) continue;
            count++;
            this.#pingCount++;
            peer.send("ping", Buffer.alloc(0));
        }
        log("Pinged to " + count + " clients");
    }

    /**
     * @param {number} port
     * @returns Promise<boolean> */
    static isPortInUse(port) {
        if (!port) throw "Invalid port: " + port;
        port = new Number(port).valueOf();
        if (port < 0 || port > 65535) throw "Invalid port: " + port;
        return new Promise(resolve => {
            const socket = new net.Socket();
            socket.on("connect", err => {
                socket.destroy();
                if (err) {
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
            socket.on("error", err => {
                socket.destroy();
                resolve(false);
            });
            socket.connect(port, "localhost");
        });
    }

    constructor(options) {
        if (!options) options = {};
        const host = this;

        if (options.tcpPort) this.#tcpPort = options.tcpPort;
        const nexus = options.nexus ? options.nexus : "wss://narrow-dolomite-morocco.glitch.me";

        RelayTCPHost.isPortInUse(this.#tcpPort).then(inUse => {
            if (!inUse) {
                logError("A multiplayer game is not currently running on port " + host.#tcpPort + ".");
                logError("Make sure to start a server or LAN world on port " + host.#tcpPort + " before hosting :)");
                return;
            }

            const connection = new WebSocket(nexus, {
                "headers": {
                    "User-Agent": "FriendJoin RelayTCPHost"
                }
            });
            this.#nexusConnection = connection;

            connection.on("error", err => {
                logError("[Nexus]", err);
            });

            connection.on("open", () => {
                log("Connected to Nexus");
                connection.send(Buffer.alloc(0));
            });
            connection.once("message", host_id => {
                host_id = Buffer.from(host_id);
                log("Created Server ID: " + host_id.toString("utf8"));

                connection.on("message", async request => {
                    request = Buffer.from(request);
                    const client_id = request.subarray(0, request[0] + 1);
                    const client_sdp = JSON.parse(request.subarray(request[0] + 1, request.length).toString("utf8"));
                    log("Client SDP:", client_sdp);
                    log("Client is joining");

                    let socket;
                    const peer = new PeerUtil(client_sdp);
                    host.#peers.add(peer);
                    peer.on("close", () => {
                        host.#peers.delete(peer);
                        if (socket) {
                            const s = socket;
                            host.#sockets.delete(socket);
                            socket = undefined;
                            s.destroy();
                        }
                        log("Closed connection with peer");
                    });
                    let lastKeepAlive;
                    peer.registerChannel("keepAlive", 0, () => {
                        lastKeepAlive = Date.now();
                    });

                    peer.registerChannel("ping", 1, () => {
                        peer.send("pong", Buffer.alloc(0));
                    });
                    peer.registerChannel("pong", 2, () => {
                        if (host.#pingCount > 0) {
                            host.#pingCount--;
                            log("A client ponged back");
                        }
                    });
                    peer.registerChannel("tcpClose", 3, () => {
                        if (socket) {
                            const s = socket;
                            socket = undefined;
                            s.destroy();
                            host.#sockets.delete(s);
                        }
                    });
                    peer.registerChannel("tcp", 4, packet => {
                        if (socket) {
                            if (host.#debug) console.log("Receiving TCP packet from client");
                            socket.write(packet);
                        } else {
                            console.log("Ignoring TCP packet");
                        }
                    });
                    peer.registerChannel("tcpOpen", 5, () => {
                        if (socket) return;
                        log("Creating a Minecraft connection");
                        socket = net.createConnection({ host: "localhost", port: host.#tcpPort }, () => {
                            log("Created a Minecraft connection");
                            peer.send("tcpOpen", Buffer.alloc(0));
                            socket.on("data", packet => {
                                if (host.#debug) log("Sending TCP");
                                peer.send("tcp", packet);
                            });
                            socket.on("error", err => logError("[Socket]", err));
                            socket.on("close", () => {
                                host.#sockets.delete(socket);
                                socket = undefined;
                                if (!peer.isClosed()) peer.send("tcpClose", Buffer.alloc(0));
                                log("Closed a Minecraft connection");
                            });
                        });
                        host.#sockets.add(socket);
                    });

                    let host_sdp;
                    try {
                        host_sdp = Buffer.from(JSON.stringify(await peer.getLocalSDP()), "utf8");
                    } catch (ex) {
                        logError(ex);
                        peer.close();
                        return;
                    }
                    log("Sending local info to client");

                    connection.send(Buffer.concat([client_id, host_sdp]));

                    try {
                        await peer.establish();
                    } catch (ex) {
                        logError(ex);
                        peer.close();
                        return;
                    }

                    log("Established a connection with a client");

                    lastKeepAlive = Date.now();
                    let keepAliveTask;
                    keepAliveTask = setInterval(() => {
                        if (peer.isClosed()) {
                            clearInterval(keepAliveTask);
                            return;
                        }
                        if (lastKeepAlive <= Date.now() - 50_000) {
                            peer.close();
                            clearInterval(keepAliveTask);
                            return;
                        }
                        peer.send("keepAlive", Buffer.alloc(0));
                    }, 3000);
                });
            });
        });
    }
}
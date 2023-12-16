import { WebSocket } from "ws";
import { PeerUtil } from "./PeerUtils.mjs";
import net, { Socket } from "node:net";

function log(message, extra) {
    if (!message) message = "";
    message = " " + message;
    const d = new Date();
    const prefix = `[${d.getUTCHours()}:${d.getUTCMinutes()}:${d.getUTCSeconds()}] [Client]`;
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
    const prefix = `[${d.getUTCHours()}:${d.getUTCMinutes()}:${d.getUTCSeconds()}] [Client] [Error]`;
    if (extra) {
        console.error(`${prefix}${message}`, extra);
    } else {
        console.error(`${prefix}${message}`);
    }
}

/**Relays packets for a TCP client over WebRTC */
export class RelayTCPClient {

    #tcpPort = 35585
    /**@type {WebSocket} */
    #nexusConnection

    #tcpQueue = []

    /**@type {PeerUtil} */
    #peer

    /**@type {Socket} */
    #tcpSocket
    /**@type {net.Server} */
    #tcpProxy

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
        if (this.#peer) this.#peer.close();
        if (this.#tcpProxy) this.#tcpProxy.close();
    }

    #pingCount = 0;

    ping() {
        if (!this.#peer.isEstablished() || this.#peer.isClosed()) {
            log("Cannot ping; connection not established yet");
            return;
        }
        this.#pingCount++;
        this.#peer.send("ping", Buffer.alloc(0));
        log("Pinged to Host");
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
        const client = this;

        const host_ID = options.host_ID ? options.host_ID.trim() : undefined;
        if (!host_ID) throw "Missing host ID";
        if (host_ID.length != 10) throw "Invalid host ID";
        if (options.tcpPort) this.#tcpPort = options.tcpPort;
        const nexus = options.nexus ? options.nexus : "wss://narrow-dolomite-morocco.glitch.me";

        /*RelayTCPClient.isPortInUse(this.#tcpPort).then(inUse => {
            if (inUse) {
                log("The port " + client.#tcpPort + " is currently in use by another program.");
                return;
            }

            //Added a better solution down below
        */

        client.#peer = new PeerUtil();

        let lastKeepAlive = Date.now();
        client.#peer.registerChannel("keepAlive", 0, () => {
            lastKeepAlive = Date.now();
        });

        client.#peer.registerChannel("ping", 1, () => {
            client.#peer.send("pong", Buffer.alloc(0));
        });

        client.#peer.registerChannel("pong", 2, () => {
            if (client.#pingCount > 0) {
                client.#pingCount--;
                log("Host ponged back");
            }
        });

        let serverOpened = false;

        client.#peer.registerChannel("tcpClose", 3, () => {
            serverOpened = false;
            client.#tcpQueue = [];
            if (client.#tcpSocket) {
                const s = client.#tcpSocket;
                client.#tcpSocket = undefined;
                s.destroy();
            }
        });

        client.#peer.registerChannel("tcp", 4, packet => {
            if (client.#tcpSocket) client.#tcpSocket.write(packet);
        });

        client.#peer.registerChannel("tcpOpen", 5, () => {
            log("Host opened Minecraft connection");
            serverOpened = true;
            let packet;
            setTimeout(() => {
                console.log("Packets Queued: " + client.#tcpQueue.length);
                while (client.#tcpQueue.length > 0) {
                    if (client.#debug) console.log("sending tcp packet from queue");
                    packet = client.#tcpQueue[0];
                    client.#tcpQueue = client.#tcpQueue.slice(1);
                    client.#peer.send("tcp", packet);
                }
            }, 200);
        });

        this.#peer.getLocalSDP().then(localSDP => {

            log("Created local info");

            let request = Buffer.from(host_ID, "utf8");
            request = Buffer.concat([Buffer.alloc(1), request]);
            request[0] = request.length - 1;
            request = Buffer.concat([request, Buffer.from(JSON.stringify(localSDP), "utf8")]);

            const connection = new WebSocket(nexus, {
                "headers": {
                    "User-Agent": "FriendJoin RelayTCPClient"
                }
            });
            client.#nexusConnection = connection;

            connection.on("error", err => {
                logError("[Nexus]", err);
            });

            connection.on("open", () => {
                log("Connected to Nexus");
                connection.send(request);
            });
            connection.once("message", async hostSDP => {
                connection.close();
                hostSDP = Buffer.from(hostSDP);
                if (hostSDP.length <= 0) {
                    log("The host isn't online");
                    client.#peer.close();
                    return;
                }
                hostSDP = hostSDP.toString("utf8");
                log("Received info from Host. Connecting");
                client.#peer.setRemoteSDP(hostSDP);

                await client.#peer.establish();
                log("Established connection with Host");

                lastKeepAlive = Date.now();
                let keepAliveTask;
                keepAliveTask = setInterval(() => {
                    if (client.#peer.isClosed()) {
                        clearInterval(keepAliveTask);
                        return;
                    }
                    if (lastKeepAlive <= Date.now() - 50_000) {
                        client.#peer.close();
                        clearInterval(keepAliveTask);
                        return;
                    }
                    client.#peer.send("keepAlive", Buffer.alloc(0));
                }, 3000);

                client.#tcpProxy = net.createServer(socket => {
                    serverOpened = false;
                    if (client.#tcpSocket) {
                        client.#tcpSocket.destroy();
                    }
                    client.#tcpQueue = [];
                    client.#tcpSocket = socket;
                    socket.on("data", packet => {
                        if (serverOpened) {
                            if (client.#debug) console.log("sending packet");
                            client.#peer.send("tcp", packet);
                        } else {
                            console.log("pushing packet to queue");
                            client.#tcpQueue.push(packet);
                        }
                    });
                    socket.on("close", () => {
                        if (!client.#peer.isClosed()) client.#peer.send("tcpClose", Buffer.alloc(0));
                        client.#tcpSocket = undefined;
                        log("Closed a Minecraft connection");
                    });
                    log("Created a Minecraft connection");
                    client.#peer.send("tcpOpen", Buffer.alloc(0));
                });
                client.#tcpProxy.on("error", err => {
                    logError("[Minecraft Connection]", err);
                });
                for (let i = 0; i < 100; i++) {
                    let occupied = await RelayTCPClient.isPortInUse(client.#tcpPort + i);
                    if (!occupied) {
                        if (i != 0) {
                            log("The default port for joining (35585) is in use by another program; trying port " + (client.#tcpPort + i));
                        }
                        client.#tcpPort += i;
                        break;
                    }
                }
                client.#tcpProxy.listen(client.#tcpPort, () => {
                    console.log("");
                    log("You may now join the game via Direct Connect:");
                    log("localhost:" + client.#tcpPort);
                });
            });

        }, rejected => {
            error("Failed to create local info:", rejected);
        });
    }
}
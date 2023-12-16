import nodeDataChannel from 'node-datachannel';

import { PeerConnection } from 'node-datachannel';
import { randomUUID } from 'node:crypto';

const iceServerList = [
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302',
    'stun:stun2.l.google.com:19302',
    'stun:stun3.l.google.com:19302',
    'stun:stun4.l.google.com:19302',
];


export class SDP {

    /**@type {string} */
    sdp

    /**@type {nodeDataChannel.DescriptionType} */
    type

    /**
     * @param {string} sdp
     * @param {nodeDataChannel.DescriptionType} type 
     */
    constructor(sdp, type) {
        this.sdp = sdp;
        this.type = type;
    }
}

export class Candidate {

    /**@type {string} */
    candidate

    /**@type {string} */
    mid

    /**
     * @param {string} candidate 
     * @param {string} mid 
     */
    constructor(candidate, mid) {
        this.candidate = candidate;
        this.mid = mid;
    }
}

export class Message {

    /**@type {SDP} */
    sdp

    /**@type {Candidate[]} */
    candidates = []
}

/**
 * @typedef {Object} OPromise
 * @property {Function} resolve
 * @property {Function} reject
 */

/**
 * @template T
 * @typedef {OPromise & Promise<T>} OpenPromise
 */


/**
 * 
 * A promise that can be resolved/rejected from the outside
 * 
 * @param {number | undefined} timeout - Milliseconds until the promise will automatically time out
 * @param {Function | undefined} timeoutFunc - Callback when the promise times out
 * @returns {OpenPromise<any>} */

function openPromise(timeout, timeoutFunc) {
    let resolver, rejecter;
    const prom = new Promise((res, rej) => {
        resolver = res;
        rejecter = rej;
    });
    prom.resolve = value => {
        if (prom.timeout) {
            clearTimeout(prom.timeout);
            delete prom.timeout;
        }
        resolver(value);
    }
    prom.reject = value => {
        if (prom.timeout) {
            clearTimeout(prom.timeout);
            delete prom.timeout;
        }
        rejecter(value);
    }
    if (timeout) {
        const _timeoutFunc = () => {
            delete prom.timeout;
            if (timeoutFunc) timeoutFunc();
            prom.reject("Timed out");
        };
        prom.timeout = setTimeout(_timeoutFunc, timeout);
    }
    return prom;
}

export class PeerUtil {

    #eventListeners = new Map();
    #channelNumbers = new Map();
    #channelNames = new Map();

    #closed = false

    /**@type {nodeDataChannel.DataChannel} */
    #datachannel

    /**@type {PeerConnection} */
    #peer

    /**@type {boolean} */
    #isInitiator

    #localSDP = new Message();

    #promises = {
        /**@type {OpenPromise<Message>} */
        localSDP: undefined,
        /**@type {OpenPromise<PeerUtil>} */
        established: undefined
    };

    getLocalSDP() {
        return this.#promises.localSDP;
    }

    isOpen() {
        return this.#datachannel && this.#datachannel.isOpen();
    }

    /**@param {Message | string} remoteSDP*/
    setRemoteSDP(remoteSDP) {
        console.log("Setting remote SDP")
        if (typeof remoteSDP == "string") {
            remoteSDP = JSON.parse(remoteSDP);
        }
        this.#peer.setRemoteDescription(remoteSDP.sdp.sdp, remoteSDP.sdp.type);
        for (let c of remoteSDP.candidates) {
            this.#peer.addRemoteCandidate(c.candidate, c.mid);
        }
        return this;
    }

    /**@returns {Promise<PeerUtil>} */
    establish() {
        return this.#promises.established;
    }

    #established = false;
    isEstablished() {
        return this.#established;
    }

    isInitiator() {
        return this.#isInitiator;
    }

    #watchDataChannel() {
        const util = this;
        this.#datachannel.onMessage(buf => {
            if (buf.length <= 0) return;
            const channelNumber = buf[0];
            const f = this.#channelNumbers.get(channelNumber);
            if (f) f(buf.subarray(1, buf.length));
        });
        this.#datachannel.onClosed(() => {
            if (!util.#closed) {
                util.#callEvent("close");
            }
        });
    }

    /**
     * @callback ChannelCallback
     * @param {Buffer} packet
     */

    /**
     * @param {string} channelName
     * @param {number} channelNumber (0-255)
     * @param {ChannelCallback} callback receives packets as Buffers
     */
    registerChannel(channelName, channelNumber, callback) {
        if (!channelName) throw "channelName isn't set";
        if (channelNumber === undefined || channelNumber < 0 || channelNumber > 255) throw "Invalid channel number: " + channelNumber;
        if (this.#channelNames.has(channelName)) throw "Channel name " + channelName + " is already registered";
        if (this.#channelNumbers.has(channelNumber)) throw "Channel number" + channelNumber + " is already registered";
        console.log("Registered channel " + channelName);
        this.#channelNumbers.set(channelNumber, callback);
        this.#channelNames.set(channelName, channelNumber);
    }

    /**
     * @param {string} channel
     * @param {Buffer} packet
     * @returns {PeerUtil}
     */
    send(channel, packet) {
        if (this.#closed || !this.#datachannel.isOpen()) return;
        if (typeof channel != "string") throw "Invalid channel";
        if (!this.#channelNames.has(channel)) throw "Channel not registered: " + channel;
        let channelNumber = this.#channelNames.get(channel);
        channelNumber = new Number(channelNumber).valueOf();
        if (channelNumber < 0 || channelNumber > 255) throw "Invalid channel";
        if (!this.#channelNumbers.has(channelNumber)) throw "Channel not registered: " + channelNumber;
        if (!(packet instanceof Buffer)) throw "msg isn't a Buffer";


        packet = Buffer.concat([Buffer.alloc(1), packet]);
        packet[0] = channelNumber;
        this.#datachannel.sendMessageBinary(packet);
        return this;
    }

    /**
     * @param {string} event
     * @param {Function} callback 
     */
    on(event, callback) {
        this.#eventListeners.set(event, callback);
    }

    /**
     * @param {string} event 
     * @param {any} data
     */
    #callEvent(event, data) {
        const f = this.#eventListeners.get(event);
        if (f) f(data);
    }

    isClosed() {
        return this.#closed;
    }

    close() {
        this.#closed = true;
        this.#promises.localSDP.reject("Utility closed");
        this.#promises.established.reject("Utility closed");
        if (this.#datachannel) this.#datachannel.close();
        this.#peer.close();
        this.#callEvent("close");
        return this;
    }

    constructor() {

        /**@type {Message} */
        let remoteSDP;

        for (let a of arguments) {
            if (a instanceof Message || a.sdp) {
                remoteSDP = a;
            } else if (typeof a == "string") {
                remoteSDP = JSON.parse(a);
            }
        }

        this.#isInitiator = (!remoteSDP);
        console.log("Initiator:", this.#isInitiator);
        let internalID = randomUUID() + "";
        if (this.#isInitiator) {
            internalID += "|a";
        } else {
            internalID += "|b";
        }

        this.#peer = new PeerConnection(internalID, { iceServers: iceServerList, maxMessageSize: 1 + (2 * 1024 * 1024) });
        this.#peer.onLocalDescription((sdp, type) => {
            this.#localSDP.sdp = { sdp, type };
        });
        this.#peer.onLocalCandidate((candidate, mid) => {
            this.#localSDP.candidates.push({ candidate, mid });
        });

        if (remoteSDP) {
            this.setRemoteSDP(remoteSDP);
        }

        this.#promises.localSDP = openPromise(20_000);
        this.#promises.established = openPromise(180_000);

        if (this.#isInitiator) {
            this.#datachannel = this.#peer.createDataChannel("data", { ordered: true });
            this.#datachannel.onOpen(() => {
                this.#watchDataChannel();
                this.#promises.localSDP.resolve(this.#localSDP);
                this.#callEvent("localSDP", this.#localSDP);
                setTimeout(() => {
                    this.#established = true;
                    this.#promises.established.resolve(this);
                    this.#callEvent("establish");
                }, 3000);
            });
        } else {
            this.#peer.onDataChannel(datachannel => {
                this.#datachannel = datachannel;
                this.#watchDataChannel();
                this.#promises.localSDP.resolve(this.#localSDP);
                this.#established = true;
                this.#promises.established.resolve(this);
                this.#callEvent("establish");
            });
        }

        this.#peer.onGatheringStateChange(state => {
            if (state != "complete") return;
            setTimeout(() => {
                this.#promises.localSDP.resolve(this.#localSDP);
            }, 5);
        });
    }
}
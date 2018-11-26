'use strict';
var CryptoJS = require("crypto-js");
var express = require("express");
var bodyParser = require('body-parser');
var WebSocket = require("ws");

var path = require('path');
var fs = require('fs');
var crypto = require('crypto');
var x509 = require('x509');
var ip = require("ip");
var security = require('./security.js')(path, fs, x509, crypto);

//envio mensagens
var http_port = process.env.HTTP_PORT || 3001;

//conexão entre os peers
var p2p_port = process.env.P2P_PORT || 6001;
var initialPeers = [];

class Block {
    constructor(index, previousHash, timestamp, data, hash, creator, publicKey, signature, ip, file, nounce) {
        this.index = index;
        this.previousHash = previousHash.toString();
        this.timestamp = timestamp;
        this.data = data;
        this.hash = hash.toString();
        this.creator = creator;
        this.publicKey = publicKey;
        this.signature = signature;
        this.ip = ip;
        this.file = file;
        this.nounce = nounce;
    }
}

var sockets = [];
var MessageType = {
    QUERY_LATEST: 0,
    QUERY_ALL: 1,
    RESPONSE_BLOCKCHAIN: 2
};

var calculateHash = function (timestamp, data, creator, publicKey, signature, ip, file, nounce) {
    return security.hash(timestamp + data + creator + publicKey + signature + ip + file + nounce);
};

var getGenesisBlock = function () {
    // return new Block(0, "0", 1465154705, "my genesis block!!", "816534932c2b7154836da6afc367695e6337db8a921823784c14378abed4f7d7");

    var signature = security.signature("Iniciando blockchain", 1);
    var nounce = mine(1465154705000, "Iniciando blockchain", "Blockchain Services", security.programPub, signature, "0.0.0.0", "");
    return new Block(0, "0", 1465154705000, "Iniciando blockchain", calculateHash(0, 1465154705000, "genesis", "Blockchain Services", security.programPub, signature, "0.0.0.0", ""), "Blockchain Services", security.programPub, signature, "0.0.0.0", "", nounce);
};

var mine = function (timestamp, data, creator, publicKey, signature, ip, file) {

    var nounce = -1;
    var hashatual = 0;

    do {
        nounce++;
        
        hashatual = calculateHash(timestamp, data, creator, publicKey, signature, ip, file, nounce);
        var temp = hashatual.split('');

    } while (temp[0] != 0);
    return nounce;

}

var blockchain = [getGenesisBlock()];

var initHttpServer = () => {
    var app = express();
    app.use(bodyParser.json());

    app.get('/blocks', (req, res) => res.send(JSON.stringify(blockchain)));
    app.post('/mineBlock', (req, res) => {
        var newBlock = generateNextBlock(req.body.data);
        addBlock(newBlock);
        broadcast(responseLatestMsg());
        console.log('block added: ' + JSON.stringify(newBlock));
        res.send();
    });
    app.get('/peers', (req, res) => {
        res.send(sockets.map(s => s._socket.remoteAddress + ':' + s._socket.remotePort));
    });
    app.post('/addPeer', (req, res) => {
        connectToPeers([req.body.peer]);
        res.send();
    });
    app.listen(http_port, () => console.log('Listening http on port: ' + http_port));
};


var initP2PServer = () => {
    var server = new WebSocket.Server({ port: p2p_port });
    server.on('connection', ws => initConnection(ws));
    console.log('listening websocket p2p port on: ' + p2p_port);

};

var initConnection = (ws) => {
    sockets.push(ws);
    initMessageHandler(ws);
    initErrorHandler(ws);
    write(ws, queryChainLengthMsg());
};

var initMessageHandler = (ws) => {
    ws.on('message', (data) => {
        var message = JSON.parse(data);
        console.log('Received message' + JSON.stringify(message));
        switch (message.type) {
            case MessageType.QUERY_LATEST:
                write(ws, responseLatestMsg());
                break;
            case MessageType.QUERY_ALL:
                write(ws, responseChainMsg());
                break;
            case MessageType.RESPONSE_BLOCKCHAIN:
                handleBlockchainResponse(message);
                break;
        }
    });
};

var initErrorHandler = (ws) => {
    var closeConnection = (ws) => {
        console.log('connection failed to peer: ' + ws.url);
        sockets.splice(sockets.indexOf(ws), 1);
    };
    ws.on('close', () => closeConnection(ws));
    ws.on('error', () => closeConnection(ws));
};


var generateNextBlock = (blockData, file, type) => {

    var nextTimestamp = new Date().getTime();
    var previousBlock = getLatestBlock();
    var nextIndex = previousBlock.index + 1;
    var nextTimestamp = new Date().getTime();

    if (type == 0) {
        var signature = security.signature(blockData, 0);
        var nounce = mine(nextTimestamp, blockData, security.publicKeyExtracted.commonName, security.programPub, signature, ip.address(), file);
        var nextHash = calculateHash(nextTimestamp, blockData, security.publicKeyExtracted.commonName, security.publicKey, signature, ip.address(), file, nounce);
        return new Block(nextIndex, previousBlock.hash, nextTimestamp, blockData, nextHash, security.publicKeyExtracted.commonName, security.publicKey, signature, ip.address(), file, nounce);
        // return new Block(nextIndex, previousBlock.hash, nextTimestamp, blockData, nextHash);
    }
};


var calculateHashForBlock = (block) => {
    return calculateHash(block.timestamp, block.data, block.creator, block.publicKey, block.signature, block.ip, block.file, block.nounce);
};

var addBlock = (newBlock) => {
    if (isValidNewBlock(newBlock, getLatestBlock())) {
        blockchain.push(newBlock);
        broadcast(responseLatestMsg());
    }
};

var isValidNewBlock = (newBlock, previousBlock) => {
    if (previousBlock.index + 1 !== newBlock.index) {
        console.log('invalid index');
        return false;
    } else if (previousBlock.hash !== newBlock.previousHash) {
        console.log('invalid previoushash');
        return false;
    } else if (calculateHashForBlock(newBlock) !== newBlock.hash) {
        console.log(typeof (newBlock.hash) + ' ' + typeof calculateHashForBlock(newBlock));
        console.log('invalid hash: ' + calculateHashForBlock(newBlock) + ' ' + newBlock.hash);
        return false;
    }
    return true;
};

var connectToPeers = (newPeers) => {
    newPeers.forEach((peer) => {
        var ws = new WebSocket(peer);
        ws.on('open', () => initConnection(ws));
        ws.on('error', () => {
            console.log('connection failed')
        });
    });
};

var handleBlockchainResponse = (message) => {
    var receivedBlocks = JSON.parse(message.data).sort((b1, b2) => (b1.index - b2.index));
    var latestBlockReceived = receivedBlocks[receivedBlocks.length - 1];
    var latestBlockHeld = getLatestBlock();
    if (latestBlockReceived.index > latestBlockHeld.index) {
        console.log('blockchain possibly behind. We got: ' + latestBlockHeld.index + ' Peer got: ' + latestBlockReceived.index);
        if (latestBlockHeld.hash === latestBlockReceived.previousHash) {
            console.log("We can append the received block to our chain");
            blockchain.push(latestBlockReceived);
            broadcast(responseLatestMsg());
        } else if (receivedBlocks.length === 1) {
            console.log("We have to query the chain from our peer");
            broadcast(queryAllMsg());
        } else {
            console.log("Received blockchain is longer than current blockchain");
            replaceChain(receivedBlocks);
        }
    } else {
        console.log('received blockchain is not longer than current blockchain. Do nothing');
    }
};

var replaceChain = (newBlocks) => {
    if (isValidChain(newBlocks) && newBlocks.length > blockchain.length) {
        console.log('Received blockchain is valid. Replacing current blockchain with received blockchain');
        blockchain = newBlocks;
        broadcast(responseLatestMsg());
    } else {
        console.log('Received blockchain invalid');
    }
};

var isValidChain = (blockchainToValidate) => {
    if (JSON.stringify(blockchainToValidate[0]) !== JSON.stringify(getGenesisBlock())) {
        return false;
    }
    var tempBlocks = [blockchainToValidate[0]];
    for (var i = 1; i < blockchainToValidate.length; i++) {
        if (isValidNewBlock(blockchainToValidate[i], tempBlocks[i - 1])) {
            tempBlocks.push(blockchainToValidate[i]);
        } else {
            return false;
        }
    }
    return true;
};

var getLatestBlock = () => blockchain[blockchain.length - 1];
var queryChainLengthMsg = () => ({ 'type': MessageType.QUERY_LATEST });
var queryAllMsg = () => ({ 'type': MessageType.QUERY_ALL });
var responseChainMsg = () => ({
    'type': MessageType.RESPONSE_BLOCKCHAIN, 'data': JSON.stringify(blockchain)
});
var responseLatestMsg = () => ({
    'type': MessageType.RESPONSE_BLOCKCHAIN,
    'data': JSON.stringify([getLatestBlock()])
});

var write = (ws, message) => ws.send(JSON.stringify(message));
var broadcast = (message) => sockets.forEach(socket => write(socket, message));

connectToPeers(initialPeers);
initHttpServer();
initP2PServer();

class logManager {

    constructor(fs, Tail) {

        var options = { separator: /([^/]*)$/, fromBeginning: false, follow: true };
        var logFiles;

        try {
            logFiles = fs.readFileSync('config', 'utf8');
        } catch (e) {
            console.log("Config cannot be open");
            process.exit(1);
        }

        logFiles = JSON.parse(logFiles);

        for (var i = 0; i < logFiles.length; i++) {
            try {
                let self = this;
                let file = logFiles[i];
                let tl = new Tail(file, options);
                tl.on("line", function (data) {

                    if (data != "") {
                        //console.log('Log Created! Block being created...'+data);
                        //addBlock(data,file, 0);
                        var newBlock = generateNextBlock(data, file, 0);
                        addBlock(newBlock);
                    }
                })
            }
            catch (e) {
                console.log(logFiles[i] + " this file cannot be open");
            }
        }
    }
}


//Log Manager
var tail = require('tail').Tail;
var fs = require('fs');
var lm = new logManager(fs, tail);


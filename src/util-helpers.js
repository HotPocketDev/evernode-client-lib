const { Buffer } = require('buffer');
const { XflHelpers } = require('./xfl-helpers');
const { EvernodeConstants } = require('./evernode-common');
const { TransactionHelper } = require('./transaction-helper');

// Utility helper functions.
class UtilHelpers {

    static decodeLeaseNftUri(hexUri) {
        // Get the lease index from the nft URI.
        // <prefix><lease index (uint16)><half of tos hash (16 bytes)><lease amount (uint32)>
        const prefixLen = EvernodeConstants.LEASE_TOKEN_PREFIX_HEX.length / 2;
        const halfToSLen = 16;
        const uriBuf = Buffer.from(hexUri, 'hex');
        return {
            leaseIndex: uriBuf.readUint16BE(prefixLen),
            halfTos: uriBuf.slice(prefixLen + 2, halfToSLen),
            leaseAmount: parseFloat(XflHelpers.toString(uriBuf.readBigInt64BE(prefixLen + 2 + halfToSLen)))
        }
    }

    static decodeLeaseTokenUri(hexUri) {
        // Get the lease index from the token's URI.
        // <prefix><lease index (uint16)><half of tos hash (16 bytes)><lease amount (uint32)>

        const asciiUri = TransactionHelper.hexToASCII(hexUri);
        const uriBuf = Buffer.from(asciiUri, 'base64');
        const prefixLen = EvernodeConstants.LEASE_TOKEN_PREFIX_HEX.length / 2;
        const halfToSLen = 16;
        return {
            leaseIndex: uriBuf.readUint16BE(prefixLen),
            halfTos: uriBuf.slice(prefixLen + 2, halfToSLen),
            leaseAmount: parseFloat(XflHelpers.toString(uriBuf.readBigInt64BE(prefixLen + 2 + halfToSLen)))
        }
    }

    static getCurrentUnixTime(format = "sec") {
        const time = Date.now();
        switch (format) {
            case "sec":
                return Math.floor(time / 1000);
            default:
                return time;
        }
    }
}

module.exports = {
    UtilHelpers
}
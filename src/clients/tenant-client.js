const { BaseEvernodeClient } = require('./base-evernode-client');
const { EvernodeEvents, MemoFormats, EventTypes, ErrorCodes, ErrorReasons, EvernodeConstants, HookParamKeys } = require('../evernode-common');
const { EncryptionHelper } = require('../encryption-helper');
const { XrplAccount } = require('../xrpl-account');
const { UtilHelpers } = require('../util-helpers');
const { EvernodeHelpers } = require('../evernode-helpers');
const { TransactionHelper } = require('../transaction-helper');

const DEFAULT_WAIT_TIMEOUT = 60000;

const TenantEvents = {
    AcquireSuccess: EvernodeEvents.AcquireSuccess,
    AcquireError: EvernodeEvents.AcquireError,
    ExtendSuccess: EvernodeEvents.ExtendSuccess,
    ExtendError: EvernodeEvents.ExtendError,
}

class TenantClient extends BaseEvernodeClient {

    /**
     * Constructs a tenant client instance.
     * @param {string} xrpAddress XRPL address of the tenant.
     * @param {string} XRPL secret of the tenant.
     * @param {object} options [Optional] An object with 'rippledServer' URL and 'governorAddress'.
     */
    constructor(xrpAddress, xrpSecret, options = {}) {
        super(xrpAddress, xrpSecret, Object.values(TenantEvents), false, options);
    }

    async prepareAccount() {
        try {
            if (!await this.xrplAcc.getMessageKey())
                await this.xrplAcc.setAccountFields({ MessageKey: this.accKeyPair.publicKey });
        }
        catch (err) {
            console.log("Error in preparing user xrpl account for Evernode.", err);
        }
    }

    async getLeaseHost(hostAddress) {
        const host = new XrplAccount(hostAddress, null, { xrplApi: this.xrplApi });
        // Find an owned URI token with matching Evernode host NFT prefix.
        const uriToken = (await host.getURITokens()).find(n => n.URI.startsWith(EvernodeConstants.TOKEN_PREFIX_HEX));
        if (!uriToken)
            throw { reason: ErrorReasons.HOST_INVALID, error: "Host is not registered." };

        // Check whether the token was actually issued from Evernode registry contract.
        if (uriToken.Issuer != this.config.registryAddress)
            throw { reason: ErrorReasons.HOST_INVALID, error: "Host is not registered." };

        // Check whether active.
        const hostInfo = await this.getHostInfo(host.address);
        if (!hostInfo)
            throw { reason: ErrorReasons.HOST_INVALID, error: "Host is not registered." };
        else if (!hostInfo.active)
            throw { reason: ErrorReasons.HOST_INACTIVE, error: "Host is not active." };

        return host;
    }

    /**
     * 
     * @param {string} hostAddress XRPL address of the host to acquire the lease.
     * @param {object} requirement The instance requirements and configuration.
     * @param {object} options [Optional] Options for the XRPL transaction.
     * @returns The transaction result.
     */
    async acquireLeaseSubmit(hostAddress, requirement, options = {}) {

        const hostAcc = await this.getLeaseHost(hostAddress);
        let selectedOfferIndex = options.leaseOfferIndex;

        let buyUriOffer = null;
        const uriTokenOffers = await EvernodeHelpers.getLeaseOffers(hostAcc);

        if (!selectedOfferIndex) {
            // Attempt to get first available offer, if offer is not specified in options.
            buyUriOffer = uriTokenOffers && uriTokenOffers[0];
        }
        else {
            // Attempt to get relevant available offer using selectedOfferIndex.
            buyUriOffer = uriTokenOffers && uriTokenOffers.find(uriOffer => { uriOffer.index === selectedOfferIndex });
        }

        if (!buyUriOffer)
            throw { reason: ErrorReasons.NO_OFFER, error: "No offers available." };

        // Encrypt the requirements with the host's encryption key (Specified in MessageKey field of the host account).
        const encKey = await hostAcc.getMessageKey();
        if (!encKey)
            throw { reason: ErrorReasons.INTERNAL_ERR, error: "Host encryption key not set." };

        const ecrypted = await EncryptionHelper.encrypt(encKey, requirement, {
            iv: options.iv, // Must be null or 16 bytes.
            ephemPrivateKey: options.ephemPrivateKey // Must be null or 32 bytes.
        });

        return this.xrplAcc.buyURIToken(
            buyUriOffer,
            [
                { type: EventTypes.ACQUIRE_LEASE, format: MemoFormats.BASE64, data: ecrypted }
            ],
            {
                hookParams: [
                    { name: HookParamKeys.PARAM_EVENT_TYPE_KEY, value: EventTypes.ACQUIRE_LEASE }
                ],
                ...options.transactionOptions
            });
    }

    /**
     * Watch for the acquire-success response after the acquire request is made.
     * @param {object} tx The transaction returned by the acquireLeaseSubmit function.
     * @param {object} options [Optional] Options for the XRPL transaction.
     * @returns An object including transaction details,instance info, and acquireReference Id.
     */
    async watchAcquireResponse(tx, options = {}) {
        console.log(`Waiting for acquire response... (txHash: ${tx.id})`);

        return new Promise(async (resolve, reject) => {
            let rejected = false;
            const failTimeout = setTimeout(() => {
                rejected = true;
                reject({ error: ErrorCodes.ACQUIRE_ERR, reason: ErrorReasons.TIMEOUT });
            }, options.timeout || DEFAULT_WAIT_TIMEOUT);

            let relevantTx = null;
            while (!rejected && !relevantTx) {
                const txList = await this.xrplAcc.getAccountTrx(tx.details.ledger_index);
                for (let t of txList) {
                    t.tx.Memos = TransactionHelper.deserializeMemos(t.tx?.Memos);
                    t.tx.HookParameters = TransactionHelper.deserializeHookParams(t.tx?.HookParameters);
                    const res = await this.extractEvernodeEvent(t.tx);
                    if ((res?.name === EvernodeEvents.AcquireSuccess || res?.name === EvernodeEvents.AcquireError) && res?.data?.acquireRefId === tx.id) {
                        clearTimeout(failTimeout);
                        relevantTx = res;
                        break;
                    }
                }
                await new Promise(resolveSleep => setTimeout(resolveSleep, 2000));
            }

            if (!rejected) {
                if (relevantTx?.name === TenantEvents.AcquireSuccess) {
                    resolve({
                        transaction: relevantTx?.data.transaction,
                        instance: relevantTx?.data.payload.content,
                        acquireRefId: relevantTx?.data.acquireRefId
                    });
                } else if (relevantTx?.name === TenantEvents.AcquireError) {
                    reject({
                        error: ErrorCodes.ACQUIRE_ERR,
                        transaction: relevantTx?.data.transaction,
                        reason: relevantTx?.data.reason,
                        acquireRefId: relevantTx?.data.acquireRefId
                    });
                }
            }
        });
    }

    /**
     * Acquire an instance from a host
     * @param {string} hostAddress XRPL address of the host to acquire the lease.
     * @param {object} requirement The instance requirements and configuration.
     * @param {object} options [Optional] Options for the XRPL transaction.
     * @returns An object including transaction details,instance info, and acquireReference Id.
     */
    acquireLease(hostAddress, requirement, options = {}) {
        return new Promise(async (resolve, reject) => {
            const tx = await this.acquireLeaseSubmit(hostAddress, requirement, options).catch(error => {
                reject({ error: ErrorCodes.ACQUIRE_ERR, reason: error.reason || ErrorReasons.TRANSACTION_FAILURE, content: error.error || error });
            });
            if (tx) {
                try {
                    const response = await this.watchAcquireResponse(tx, options);
                    resolve(response);
                } catch (error) {
                    reject(error);
                }
            }
        });
    }

    /**
     * This function is called by a tenant client to submit the extend lease transaction in certain host. This function will be called inside extendLease function. This function can take four parameters as follows.
     * @param {string} hostAddress XRPL account address of the host.
     * @param {number} amount Cost for the extended moments , in EVRs.
     * @param {string} tokenID Tenant received instance name. this name can be retrieve by performing acquire Lease.
     * @param {object} options This is an optional field and contains necessary details for the transactions.
     * @returns The transaction result.
     */
    async extendLeaseSubmit(hostAddress, amount, tokenID, options = {}) {
        const host = await this.getLeaseHost(hostAddress);
        return this.xrplAcc.makePayment(
            host.address, amount.toString(),
            EvernodeConstants.EVR,
            this.config.evrIssuerAddress,
            null,
            {
                hookParams: [
                    { name: HookParamKeys.PARAM_EVENT_TYPE_KEY, value: EventTypes.EXTEND_LEASE },
                    { name: HookParamKeys.PARAM_EVENT_DATA1_KEY, value: tokenID }
                ],
                ...options.transactionOptions
            });
    }

    /**
     * This function watches for an extendlease-success response(transaction) and returns the response or throws the error response on extendlease-error response from the host XRPL account. This function is called within the extendLease function.
     * @param {object} tx Response of extendLeaseSubmit.
     * @param {object} options This is an optional field and contains necessary details for the transactions.
     * @returns An object including transaction details.
     */
    async watchExtendResponse(tx, options = {}) {
        console.log(`Waiting for extend lease response... (txHash: ${tx.id})`);

        return new Promise(async (resolve, reject) => {
            let rejected = false;
            const failTimeout = setTimeout(() => {
                rejected = true;
                reject({ error: ErrorCodes.EXTEND_ERR, reason: ErrorReasons.TIMEOUT });
            }, options.timeout || DEFAULT_WAIT_TIMEOUT);

            let relevantTx = null;
            while (!rejected && !relevantTx) {
                const txList = await this.xrplAcc.getAccountTrx(tx.details.ledger_index);
                for (let t of txList) {
                    t.tx.Memos = TransactionHelper.deserializeMemos(t.tx.Memos);
                    t.tx.HookParameters = TransactionHelper.deserializeHookParams(t.tx?.HookParameters);
                    const res = await this.extractEvernodeEvent(t.tx);
                    if ((res?.name === TenantEvents.ExtendSuccess || res?.name === TenantEvents.ExtendError) && res?.data?.extendRefId === tx.id) {
                        clearTimeout(failTimeout);
                        relevantTx = res;
                        break;
                    }
                }
                await new Promise(resolveSleep => setTimeout(resolveSleep, 1000));
            }

            if (!rejected) {
                if (relevantTx?.name === TenantEvents.ExtendSuccess) {
                    resolve({
                        transaction: relevantTx?.data.transaction,
                        expiryMoment: relevantTx?.data.expiryMoment,
                        extendRefId: relevantTx?.data.extendRefId
                    });
                } else if (relevantTx?.name === TenantEvents.ExtendError) {
                    reject({
                        error: ErrorCodes.EXTEND_ERR,
                        transaction: relevantTx?.data.transaction,
                        reason: relevantTx?.data.reason
                    });
                }
            }
        });
    }

    /**
     * This function is called by a tenant client to extend an available instance in certain host. This function can take four parameters as follows.
     * @param {string} hostAddress XRPL account address of the host.
     * @param {number} moments 1190 ledgers (est. 1 hour).
     * @param {string} instanceName Tenant received instance name. this name can be retrieve by performing acquire Lease.
     * @param {object} options This is an optional field and contains necessary details for the transactions.
     * @returns An object including transaction details.
     */
    extendLease(hostAddress, moments, instanceName, options = {}) {
        return new Promise(async (resolve, reject) => {
            const tokenID = instanceName;
            const uriToken = (await this.xrplAcc.getURITokens())?.find(n => n.index == tokenID);

            if (!uriToken) {
                reject({ error: ErrorCodes.EXTEND_ERR, reason: ErrorReasons.NO_TOKEN, content: 'Could not find the uri token for lease extend request.' });
                return;
            }

            let minLedgerIndex = this.xrplApi.ledgerIndex;

            // Get the agreement lease amount from the nft and calculate EVR amount to be sent.
            const uriInfo = UtilHelpers.decodeLeaseTokenUri(uriToken.URI);
            const tx = await this.extendLeaseSubmit(hostAddress, moments * uriInfo.leaseAmount, tokenID, options).catch(error => {
                reject({ error: ErrorCodes.EXTEND_ERR, reason: error.reason || ErrorReasons.TRANSACTION_FAILURE, content: error.error || error });
            });

            if (tx) {
                try {
                    const response = await this.watchExtendResponse(tx, minLedgerIndex, options)
                    resolve(response);
                } catch (error) {
                    reject(error);
                }
            }
        });
    }
}

module.exports = {
    TenantEvents,
    TenantClient
}

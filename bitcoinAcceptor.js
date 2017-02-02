// bitcoinAcceptor.js: replacement for accept-bitcoin that actually works

var extend = require('extend')
var bitcore = require('bitcore-lib')
var request = require('request')

//Private
var privateVariable = true



//Public
module.exports = BitcoinAcceptor;

/**
 * Make a new BitcoinAcceptor sending porceeds to the given address, with the
 * given settings.
 */
function BitcoinAcceptor(destination, settings = {}) {
  
  if (!destination) {
    throw new Error('No destination address specified')
  }
  
  this.destination = destination
  
  // Have default settings
  this.settings = {
    network: 'test', // Can be 'test' or 'live'
    checkTransactionEvery: (1000 * 60 * 2), // 2 minutes
    checkBalanceTimeout: (1000 * 60 * 60),  // 60 minutes
    checkUnspentTimeout: (1000 * 60 * 60), // 60 minutes
    minimumConfirmations: 1,
    txFee: 0.0001
  }
  
  // Apply custom settings over defaults
  extend(this.settings, settings)
  
  // Pick a network object
  if (this.settings.network == 'test') {
    // Adopt test network
    this.network = bitcore.Networks.testnet
    // And testnet API url
    this.apiBase = 'https://tbtc.blockr.io/api/v1'
  } else if (this.settings.network == 'live') {
    // Adopt the main net network
    this.network = bitcore.Networks.livenet
    // And the main net API URL
    this.apiBase = 'https://btc.blockr.io/api/v1'
  } else {
    throw new Error('Invalid network: ' + this.settings.network)
  }
  
}

/**
 * Generate a new payment key for an invoice.
 */
BitcoinAcceptor.prototype.generateKey = function () {
  return new bitcore.PrivateKey(null, this.network)
}

/**
 * Get the balance of the given private key or address, as a float in BTC. Calls the callback
 * with err on error, or null and the balance on success.
 */
BitcoinAcceptor.prototype.checkBalance = function (privkeyOrAddr, callback) {
  
  // Decide on the real address string
  var addrString
  
  if (privkeyOrAddr instanceof bitcore.PrivateKey) {
    // We got a priv key, Hide it!
    addrString = privkeyOrAddr.toAddress().toString()
  } else if (privkeyOrAddr instanceof bitcore.Address) {
    // We got an Address object. It would get stringified automatically but do
    // it manually.
    addrString = privkeyOrAddr.toString()
  } else if (bitcore.Address.isValid(privkeyOrAddr)) {
    // It's just a string address
    addrString = privkeyOrAddr
  } else {
    // What is this nonsense?
    callback(new Error('Invalid address: ' + privkeyOrAddr))
  }
  
  // Make a request to the appropriate endpoint
  request.get(this.apiBase + '/address/info/' + addrString, (err, response, body) => {
    if (err) {
      return callback(err)
    }
    
    try {
      // Parse the returned JSON
      body = JSON.parse(body)
      
      callback(null, body.data.balance);
      
    } catch (err) {
      return callback(err)
    }
    
  })
}














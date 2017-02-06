// bitcoinAcceptor.js: replacement for accept-bitcoin that actually works

var extend = require('extend')
var bitcore = require('bitcore-lib')
var request = require('request')
var async = require('async')

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
 * Convert the given PrivateKey or Address or string to an actuall address
 * string. Calls the callback with an error if the address given is invalid, and
 * with null and the string otherwise.
 */
BitcoinAcceptor.prototype.toAddress = function(privkeyOrAddr, callback) {
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
    return callback(new Error('Invalid address: ' + privkeyOrAddr))
  }
  
  callback(null, addrString)
}

/**
 * Get the balance of the given private key or address, as a float in BTC. Calls the callback
 * with err on error, or null and the balance on success.
 */
BitcoinAcceptor.prototype.checkBalance = function (privkeyOrAddr, callback) {
  
  // Parse the address
  this.toAddress(privkeyOrAddr, (err, addrString) => {
    if (err) {
      return callback(err)
    }
    
    // Make a request to the appropriate endpoint
    var apiCall = '/address/balance/' + addrString + '?confirmations=' + this.settings.minimumConfirmations
    request.get(this.apiBase + apiCall, (err, response, body) => {
      if (err) {
        return callback(err)
      }
      
      var balance;
      
      try {
        // Parse the returned JSON
        body = JSON.parse(body)
        // Go look for the key we want
        balance = body.data.balance
      } catch (err) {
        return callback(err)
      }
      
      callback(null, balance);
      
    })
  })
}

/**
 * Get the unspent outputs available to the given address. Calls the callback
 * with an error if there is an error, or null and the result otherwise.
 *
 * Filters down to transactions with sufficient confirmations, and returns an
 * array of Bitcore UnspentOutput objects.
 */
BitcoinAcceptor.prototype.getUnspent = function (privkeyOrAddr, callback) {
  
  // Parse the address
  this.toAddress(privkeyOrAddr, (err, addrString) => {
    if (err) {
      return callback(err)
    }
    
    // Make a request to the appropriate endpoint.
    // Include unconfirmed transactions in the list if we don't need any confirmations
    var apiCall = '/address/unspent/' + addrString + (this.settings.minimumConfirmations == 0 ? '?unconfirmed=1' : '')
    request.get(this.apiBase + apiCall, (err, response, body) => {
      if (err) {
        return callback(err)
      }
      
      var uxtos;
      
      try {
        // Parse the returned JSON
        body = JSON.parse(body)
        // Result is in .data.unspent[].
        uxtos = body.data.unspent
      } catch (err) {
        return callback(err)
      }
      
      // Items look like:
      // {"tx":"c653ac1e7a66117e097dd16cfd122b24b0f92060d096d8754a1e550d4c64f520",
      //  "amount":"0.00020000",
      //  "n":2,
      //  "confirmations":27056,
      //  "script":"76a914592fc3990026334c8c6fb2b9da457179cdb5c68888ac"}
      
      async.filter(uxtos, (item, callback) => {
        // For each item
        if (item.confirmations >= this.settings.minimumConfirmations) {
          // If it has enough, keep it
          return callback(null, true);
        } else {
          // If it has too few or undefined confirmations, drop it.
          return callback(null, false);
        }
      }, (err, acceptableUxtos) => {
        // Now we have just the UXTOs that are acceptable. Turn them into the right kind of objects.
        if (err) {
          return callback(err)
        }
        
        // Now convert to UnspentOutput objects and feed the results to our
        // callback
        async.map(acceptableUxtos, (item, callback) => {
          try {
            // Convert object to UnspentOutput
            var uxto = new bitcore.Transaction.UnspentOutput({
              txid: item.tx,
              vout: item.n,
              address: addrString,
              scriptPubKey: item.script,
              amount: parseFloat(item.amount)
            })
            
            return callback(null, uxto)
          } catch(err) {
            return callback(err)
          }
        }, callback)
        
      })
      
    })
  })
  
}












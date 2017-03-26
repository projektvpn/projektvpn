// bitcoinAcceptor.js: replacement for accept-bitcoin that actually works

const extend = require('extend')
const bitcore = require('bitcore-lib')
const request = require('request')
const async = require('async')
const limiter = require('limiter');

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
  
  // Have default settings
  this.settings = {
    network: 'test', // Can be 'test' or 'live'
    minimumConfirmations: 1,
    fiatCurrency: 'USD', // Any supported by exchange rate source
    // Fee per KB is the Bitcore default
    balanceChecksPerHour: 60 * 60
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
  
  // Start rate limiting
  this.limiter = new limiter.RateLimiter(this.settings.balanceChecksPerHour, 'hour')
  
  // Save the address all funds go to, as a Bitcore parsed Address object
  this.destination = new bitcore.Address(destination, this.network)
  
}

/**
 * Generate a new payment key for an invoice.
 */
BitcoinAcceptor.prototype.generateKey = function () {
  return new bitcore.PrivateKey(null, this.network)
}

/**
 * Load a serialized key on the appropriate network.
 */
BitcoinAcceptor.prototype.loadKey = function (keyString) {
  return new bitcore.PrivateKey(keyString, this.network)
}

/**
 * Convert the given PrivateKey or Address or string to an actuall address
 * string. Calls the callback with an error if the address given is invalid, and
 * with null and the string otherwise.
 */
BitcoinAcceptor.prototype.toAddress = function (privkeyOrAddr, callback) {
  // Decide on the real address string
  var addrString
  
  if (privkeyOrAddr instanceof bitcore.PrivateKey) {
    // We got a priv key, Hide it!
    addrString = privkeyOrAddr.toAddress(this.network).toString()
  } else if (privkeyOrAddr instanceof bitcore.Address) {
    // We got an Address object. It would get stringified automatically but do
    // it manually.
    addrString = privkeyOrAddr.toString()
  } else if (bitcore.Address.isValid(privkeyOrAddr, this.network)) {
    // It's just a string address
    addrString = privkeyOrAddr
  } else {
    // What is this nonsense?
    return callback(new Error('Invalid address: ' + privkeyOrAddr))
  }
  
  callback(null, addrString)
}

/**
 * Get the exchange rate, in fiat units per BTC. The default fiat currency is
 * USD.
 *
 * This attempts to get the rate from blockr, but the blockr rate is very wrong,
 * so it's not used.
 */
BitcoinAcceptor.prototype.getBlockrExchangeRate = function (callback) {
  // Make a request to the appropriate endpoint
  var apiCall = '/exchangerate/current'
  request.get(this.apiBase + apiCall, (err, response, body) => {
    if (err) {
      return callback(err)
    }
    
    var rate;
    
    try {
      // Parse the returned JSON
      body = JSON.parse(body)
      // Go look for the rates we want, and divide to get the normal-style exchange rate
      rate = body.data[0].rates[this.settings.fiatCurrency] / body.data[0].rates['BTC']
    } catch (err) {
      return callback(err)
    }
    
    // Send back the rate
    callback(null, rate);
    
  })
}

/**
 * Get the exchange rate, in fiat units per BTC. The default fiat currency is
 * USD.
 *
 * This uses the Blockchain.info ticker API.
 */
BitcoinAcceptor.prototype.getExchangeRate = function (callback) {
  // Make a request to the blockchain.info ticker
  request.get('https://blockchain.info/ticker', (err, response, body) => {
    if (err) {
      return callback(err)
    }
    
    var rate;
    
    try {
      // Parse the returned JSON
      body = JSON.parse(body)
      // Go look for the rate we want (most recent exchange rate)
      rate = body[this.settings.fiatCurrency]['last']
    } catch (err) {
      return callback(err)
    }
    
    // Send back the rate
    callback(null, rate);
    
  })
}

/**
 * Convert the given fiat amount into a non-nonsensical (i.e. to-the-satoshi)
 * amount of BTC, using the given exchange rate.
 */
BitcoinAcceptor.prototype.fiatToBtc = function (fiat, exchangeRate) {
  return bitcore.Unit.fromFiat(fiat, exchangeRate).toBTC()
}

/**
 * Convert the given BTC amount into an amout of fiat, using the given exchange
 * rate.
 */
BitcoinAcceptor.prototype.btcToFiat = function (btc, exchangeRate) {
  return bitcore.Unit.fromBTC(btc).atRate(exchangeRate)
}

/**
 * Convert the given BTC amount into an integral number of Satoshis.
 */
BitcoinAcceptor.prototype.btcToSatoshis = function (btc) {
  return bitcore.Unit.fromBTC(btc).toSatoshis()
}

/**
 * Convert the given number of Satoshis to a BTC amount.
 */
BitcoinAcceptor.prototype.satoshisToBtc = function (satoshis) {
  return bitcore.Unit.fromSatoshis(satoshis).toBTC()
}

/**
 * Get the balance of the given private key or address, as a float in BTC. Calls the callback
 * with err on error, or null and the balance on success.
 */
BitcoinAcceptor.prototype.getBalance = function (privkeyOrAddr, callback) {
  
  // Log a request against our rate limit
  this.limiter.removeTokens(1, (err, tokens_left) => {
    if (err) {
      return callback(err)
    }
    
    if (tokens_left < 0) {
      // Don't make requests faster than we're supposed to
      return callback(new Error('Local balance check rate limit hit'))
    }
  
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
  }, true) // Make sure to fail to get tokens fast instead of waiting.
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
          var uxto
          
          try {
            // Convert object to UnspentOutput
            uxto = new bitcore.Transaction.UnspentOutput({
              txid: item.tx,
              vout: item.n,
              address: addrString,
              scriptPubKey: item.script,
              amount: parseFloat(item.amount)
            })
            
          } catch(err) {
            return callback(err)
          }
          
          return callback(null, uxto)
          
        }, callback)
        
      })
      
    })
  })
}

/**
 * Broadcast the given signed Bitcore Transaction object. Call the callback with
 * an error if it fails, or null if it succeeds.
 */
BitcoinAcceptor.prototype.sendTransaction = function (transaction, callback) {
  try {
    var apiCall = '/tx/push'
    // Convert transaction to hex
    var toPost = transaction.serialize()
    
    // Send it and get a response
    request.post({url: this.apiBase + apiCall, json: {hex: toPost}},  (err, response, body) => {
      if (err) {
        return callback(err)
      }
    
      console.log('Reply: ', body)
    
      // Make sure the other end liked it
      
      // Body is already parsed as json by request module, since we sent JSON.
      
      if (body.status != 'success') {
        // The other end didn't like it.
        return callback(new Error('Received bad response when posting transaction: ' + JSON.stringify(body)))
      }
      
      // If we get here the other end definitely liked it. Report success.
      return callback(null)
    })
    
  } catch (err) {
    return callback(err)
  }
}

/**
 * Get the unspent outputs for a privkey and sweep them all to the address
 * specified in settings. Calls the callback with an error if it fails, or null
 * and the amount swept in BTC if it succeeds.
 *
 * Will fail if there aren't enough funds in the address to pay for the
 * transaction.
 */
BitcoinAcceptor.prototype.sweep = function (privkey, callback) {

  this.getUnspent(privkey, (err, uxtos) => {
    // Grab the unspent outputs for the given key
    if(err) {
      return callback(err)
    }
    
    if (!(privkey instanceof bitcore.PrivateKey) &&
      !bitcore.PrivateKey.isValid(privkey, this.network)) {
      // We won't be able to sign things with something that isn't a privkey on
      // our network.
      return callback(new Error('Private key is not a valid private key on current network: ' + privkey))
    }
    
    try {
    
      // Make a transaction. Don't give it any real outputs, but do tell it to
      // send change (i.e. sweep the UXTOs).
      var transaction = new bitcore.Transaction()
        .from(uxtos)
        .change(this.destination)
        .sign(privkey)
        
      // Send it off
      this.sendTransaction(transaction, (err) => {
        if (err) {
          return callback(err)
        }
        
        try {
          // If the send succeeded, send back the amount moved.
          var moved = bitcore.Unit.fromSatoshis(transaction._getOutputAmount()).toBTC()
          
          callback(null, moved)
        } catch (err) {
          callback(err)
        }
      })
    
    } catch (err) {
      return callback(err)
    }
    
  })
  
  

}












// Set up secret credentials
require('dotenv').config()

// We need this to help with the callbacks
var async = require('async')

var express = require('express')
var expressHandlebars = require('express-handlebars')
var acceptBitcoin = require('accept-bitcoin')
var cjdnsAdmin = require('cjdns-admin')
var moment = require('moment')

// Find our pubkey code stolen from cjdns
var publicToIp6 = require('./publicToIp6')

// Set up express
var app = express()
// Register '.hbs' extension with Handlebars
app.engine('handlebars', expressHandlebars({defaultLayout: 'main'}));
app.set( 'view engine', 'handlebars' );

// Set up accept-bitcoin
var accepter = new acceptBitcoin(process.env.BTC_PAYTO, {
  network: process.env.BTC_NETWORK, 
  storePath: 'generatedKeys.txt',
  encryptPrivateKey: false,
  minimumConfirmations: 1
})

// Set up database
var Client = require('mariasql')
var c = new Client({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  db: process.env.DB_DATABASE
})

// Upgrade the DB and create missing tables, then call the callback
function upgradeDatabase(callback) {
  console.log('Upgrade database...')

  // Define all the tables we want
  var tables = [
    // A table for accounts
    `CREATE TABLE IF NOT EXISTS account(
      id INT PRIMARY KEY, 
      pubkey VARCHAR(80) UNIQUE NOT NULL, 
      paid_through DATETIME DEFAULT CURRENT_TIMESTAMP,
      active BOOL DEFAULT FALSE  
    );`,
    // A table for associating payment destinations with accounts in case we
    // lose one
    `CREATE TABLE IF NOT EXISTS btc_address(
      id INT PRIMARY KEY,
      account_id INT NOT NULL,
      address VARCHAR(34) UNIQUE NOT NULL,
      privkey VARCHAR(64),
      FOREIGN KEY (account_id) REFERENCES account(id)
    );`,
    // A table for IPv4 networks (each has 255 IPs we can assign)
    `CREATE TABLE IF NOT EXISTS ip4_network(
      id INT PRIMARY KEY,
      network VARCHAR(16) UNIQUE NOT NULL
    );`,
    // A table for actually instantiated IPs (which we can reuse when they get
    // de-assigned)
    `CREATE TABLE IF NOT EXISTS ip4_address(
      id INT PRIMARY KEY,
      ip VARCHAR(16) UNIQUE NOT NULL,
      last_octet INT NOT NULL,
      account_id INT,
      network_id INT NOT NULL,
      FOREIGN KEY (network_id) REFERENCES ip4_network(id),
      FOREIGN KEY (account_id) REFERENCES account(id)
    );`,
    // A table for single-value settings that change (BTC price, service price,
    // max users)
    `CREATE TABLE IF NOT EXISTS kvstore(
      name VARCHAR(20) PRIMARY KEY,
      value VARCHAR(20)
    );`
  ]
  
  async.each(tables, (statement, callback) => {
    // For each statement, run it and forward the error on
    c.query(statement, (err, rows) => {
      callback(err)
    })
  }, callback)
}

// Get a config value from the database and call the callback with it If a
// fallback is specified, it gets used if nothing is there. By default, if
// nothing is there, the callback is called with undefined. If a value is there
// it is returned as a string.
function getConfig(key, fallback, callback) {
  if (!callback) {
    // Fallback parameter is optional, but callback isn't
    callback = fallback
    fallback = undefined
  }
  c.query('SELECT (value) FROM kvstore WHERE name = ?;', [key], (err, rows) => {
    if (err) {
      return callback(err)
    }
    
    if (rows.length == 0) {
      callback(null, fallback)
    } else {
      callback(null, rows[0]['value'])
    }
    
  }) 
}

// Set a config value in the database, then call the given callback
function setConfig(key, value, callback) {
  c.query('INSERT INTO kvstore (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE;', [key, value], (err, rows) => {
    callback(err)
  }) 
}

// Set a config value in the database only if it is unset
function defaultConfig(key, value, callback) {
  c.query('INSERT IGNORE INTO kvstore (name, value) VALUES (?, ?);', [key, value], (err, rows) => {
    callback(err)
  }) 
}

// Set up some default config values, if not set already
function setupDefaultConfig(callback) {
  console.log('Default any unset config values...')
  // Here are a bunch of defaults
  defaults = [
    ["maxUsers", "100"],
    ["servicePrice", "5"],
    ["btcValue", "800"]
  ]
  async.each(defaults, (pair, callback) => {
    // Apply each as a default if nothing is set
    defaultConfig(pair[0], pair[1], callback)
  }, callback)
}

// Get the monthly price in BTC that we charge
function getMonthlyPrice(callback) {
  // Grab the service price and the value of bitcoins
  async.map(["servicePrice", "btcValue"], getConfig, (err, results) => {
    if (err) {
      return callback(err)
    }
    
    // Work out how much we charge a month in BTC
    var monthlyPrice = parseFloat(results[0]) / parseFloat(results[1])
    
    // Send it out
    callback(null, monthlyPrice)
    
  })
}

// Look up an account by key. Call the callback with an error, or null and the
// returned record (which may not be in the database because it holds no non-
// default info)
function getAccount(pubkey, callback) {
  c.query('SELECT * FROM account WHERE pubkey = ?;', [pubkey], (err, rows) => {
    if (err) {
      return callback(err)
    }
    
    // Pull or synthesize the record
    var record
    if (rows.length == 0) {
      // Make a default record
      record = {
        id: null,
        pubkey: pubkey,
        active: false,
        paid_through: null
      }
    } else {
      // Use the record we found
      record = rows[0]
    }
    callback(null, record)
  })
}

// Get the account with the given pubkey, or create and remember one if none
// existed before.
function getOrCreateAccount(pubkey, callback) {
  c.query('SELECT * FROM account WHERE pubkey = ?;', [pubkey], (err, rows) => {
    if (err) {
      return callback(err)
    }
    
    // Pull or synthesize the record
    if (rows.length == 0) {
      // Make a new account
      c.query('INSERT INTO account (pubkey) VALUES (?);', [pubkey], (err, rows) => {
        if (err) {
          return callback(err)
        }
        
        // Then get it back (TODO: Is there a better way?)
        c.query('SELECT * FROM account WHERE pubkey = ?;', [pubkey], (err, rows) => {
        
          if (err) {
            return callback(err)
          }
        
          // Use the record we created
          record = rows[0]
          callback(null, record)
        })
      })
    } else {
      // Use the record we found
      record = rows[0]
      callback(null, record)
    }
    
  })
}

// Given the address of an account and an accept-bitcoin key object, add the
// Bitcoin address to the account in our log.
function addBtcAddress(account_id, key, callback) {
  c.query('INSERT INTO btc_address (account_id, address, privkey) VALUES (?, ?, ?);',
    [account_id, key.address(), key.privateKey()], (err, rows) => {
    
    if (err) {
      return callback(err)
    }
    
    console.log('Account #', account_id, ' associated with address ', key.address())
    
    callback(null)
    
  })
}

// Pay up an account for a month. Takes an already-pulled-from-the-database
// account object reflecting the state of the account before the payment was
// made.
function addTime(account, callback) {
  
  // Parse the old paid through date
  var paid_through = moment(account.paid_through);
  
  if (paid_through < moment()) {
    // If it's expired, sset it paid until now
    paid_through = moment()
  }
  
  // Now add a (standard) month
  paid_through = paid_through.add(31, 'days')
  
  // Update the date. We leave the active flag alone.
  c.query('UPDATE account SET paid_through = ? WHERE id = ?', [paid_through, account.id], (err, rows) => {
    if (err) {
      callback(err)
    }
    
    console.log('Account ', account.pubkey, ' paid through ', paid_through)
    
    if (!account.active) {
      // We need to activate the account
      activateAccount(account, callback)
    } else {
      callback(null)
    }
  })
  
}

// Activate an account that was inactive. Assign an IP and maybe tell cjdns about it.
function activateAccount(account, callback) {
  // Mark the account active
  // TODO: do this last so we will notice if activation failed
  c.query('UPDATE account SET active = TRUE WHERE id = ?', [account.id], (err, rows) => {
    if (err) {
      throw err
    }
    
    console.log('Activated ', account.pubkey)
    
    // TODO: assign IP, tell cjdns
    
  })
}

// This function calls the callback with an error if the given key is not a
// valid pubkey, and with null and the IP address if it is.
function parsePubkey(pubkey, callback) {
  try {
    var ip6 = publicToIp6.convert(pubkey)
    callback(null, ip6)
  } catch (err) {
    callback(err)
  }
}

////////////////////////////////////////////////////////////////////////////////

// Now we define the actual web methods

app.get('/', function (req, res) {
  c.query('SELECT COUNT(*) FROM account WHERE active = TRUE;', null, {useArray: true}, (err, rows) => {
    if (err) {
      throw err
    }
    
    res.render('index', {
      title: 'Index',
      active_accounts: rows[0][0]
    })
  })
})

// Add a function to print the info for an account
app.get('/account/:pubkey', function (req, res) {
  
  var pubkey = req.params['pubkey']

  // Make sure it's a legit key
  parsePubkey(pubkey, (err, ip6) => {
    
    if (err) {
      // It's not a valid key
      return res.render('error', {message: 'Invalid public key'})
    }

    // Otherwise it checks out, so try looking it up
    getAccount(pubkey, (err, record) => {
      if (err) {
        throw err
      }
      
      // Stick the IP6 in the record
      record['ip6'] = ip6
      
      // Render a page about the account
      res.render('account', {
        account: record,
        title: record.pubkey
      })
      
    })
  })
})

// Add a function to generate an invoice
app.post('/account/:pubkey/invoice', function (req, res) {
  var pubkey = req.params['pubkey']

  // Make sure it's a legit key
  parsePubkey(pubkey, (err, ip6) => {
    
    if (err) {
      // It's not a valid key
      return res.render('error', {message: 'Invalid public key'})
    }
    
    // Otherwise, it's a valid key. We need to make an account
    getOrCreateAccount(pubkey, (err, account) => {
      if (err) {
        throw err
      }
    
      // Calculate a price quote in BTC for this transaction
      getMonthlyPrice((err, monthlyPrice) => {
        if (err) {
          throw err
        }
        
        // Make a bitcoin key to accept payment
        var btcKey = accepter.generateAddress({alertWhenHasBalance: true})
        
        // Log it in the database
        addBtcAddress(account.id, btcKey, (err) => {
        
          if (err) {
            throw err
          }
          
          // Set up a handler for the actual payment
          key.on('hasBalance', (amount) => {
            console.log('Key ', key.address(), ' has balance ', amount)
            key.transferBalanceToMyAccount((err, reply) => {
              if (err) {
                throw err
              }
              if (reply.status != 'success') {
                throw Error("Unsuccessful response: " + JSON.stringify(reply))
              }
              
              console.log('Sent funds from ', key.address())
              
              // If we get here the payment was successful. But was it enough?
              if (amount >= monthlyPrice) {
                // Yep!
                
                // TODO: calculate how to add more than 1 month if they overpaid
                
                addTime(account, (err) => {
                  if (err) {
                    throw err
                  }
                  
                  // TODO: tell the user they're paid up
                  
                })
              } else {
              
                // TODO: send a message or something (return the private key?) if they underpaid
              
              }
              
            })
          })
          
          // Now that we can take payment, tell the client
          return res.render('invoice', {
            title: "Invoice",
            account: account,
            monthlyPrice: monthlyPrice,
            btcAddress: key.address()
          })
          
        })
      })
    })
    
  })
})

// Now here's the app startup

// Do some configuring
async.series([upgradeDatabase, setupDefaultConfig], (err) => {
  if (err) {
    // Setup didn't go so well
    throw err
  }
  // Then start the app
  app.listen(3000, 'localhost', () => {
    // Then tell the user
    console.log('Example app listening on port 3000!')
    
    getMonthlyPrice((err, price) => {
      if (err) {
        throw err
      }
      console.log('Monthly price: ', price, ' BTC')
    })
    
  })
})
  

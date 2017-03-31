// Set up secret credentials
require('dotenv').config()

// We need this to help with the callbacks
const async = require('async')

const express = require('express')
const expressHandlebars = require('express-handlebars')
const bodyParser = require('body-parser')
const bitcoinAcceptor = require('./bitcoinAcceptor')
const cjdnsAdmin = require('cjdns-admin')
const moment = require('moment')
const qrImage = require('qr-image')
const externalIP = require('external-ip')();

// Find our pubkey code stolen from cjdns
const publicToIp6 = require('./publicToIp6')

// Set up express
const app = express()
// Register '.hbs' extension with Handlebars
app.engine('handlebars', expressHandlebars({defaultLayout: 'main'}));
app.set( 'view engine', 'handlebars' );
// Set up POST form parsing
app.use(bodyParser.urlencoded({extended: false}))

// Set up bitcoinAcceptor
const acceptor = new bitcoinAcceptor(process.env.BTC_PAYTO, {
  network: process.env.BTC_NETWORK, 
  minimumConfirmations: 1
})

// Set up database
const Client = require('mariasql')
const c = new Client({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  db: process.env.DB_DATABASE
})

// Connect to cjdns
const admin = cjdnsAdmin.createAdmin({
  ip: process.env.CJDNS_ADMIN_HOST || 'localhost',
  port: process.env.CJDNS_ADMIN_PORT || 11234,
  password: process.env.CJDNS_ADMIN_PASS
})

admin.on(admin.ping(), (response) => {
  // Report on the cjdns node
  console.log('CJDNS ping reponse: ', response.data.q)
})

// Upgrade the DB and create missing tables, then call the callback
function upgradeDatabase(callback) {
  console.log('Upgrade database...')

  // Define all the tables we want
  var tables = [
    // A table for accounts
    `CREATE TABLE IF NOT EXISTS account(
      id INT AUTO_INCREMENT PRIMARY KEY, 
      pubkey VARCHAR(80) UNIQUE NOT NULL, 
      paid_through DATETIME DEFAULT CURRENT_TIMESTAMP,
      active BOOL DEFAULT FALSE  
    );`,
    // A table for associating payment destinations with accounts, for
    // remembering and synchronizing on orders. Tracks how much was expected to
    // be received in the given address (in satoshis), and whether it was
    // detected and credited or not.
    `CREATE TABLE IF NOT EXISTS btc_address(
      id INT AUTO_INCREMENT PRIMARY KEY,
      account_id INT NOT NULL,
      address VARCHAR(34) UNIQUE NOT NULL,
      privkey VARCHAR(64),
      expected_payment BIGINT NOT NULL,
      requested DATETIME DEFAULT CURRENT_TIMESTAMP,
      received BOOL DEFAULT FALSE,
      FOREIGN KEY (account_id) REFERENCES account(id)
    );`,
    // A table for IPv4 networks (each has 255 IPs we can assign)
    `CREATE TABLE IF NOT EXISTS ip4_network(
      id INT AUTO_INCREMENT PRIMARY KEY,
      network VARCHAR(16) UNIQUE NOT NULL
    );`,
    // A table for actually instantiated IPs (which we can reuse when they get
    // de-assigned)
    `CREATE TABLE IF NOT EXISTS ip4_address(
      id INT AUTO_INCREMENT PRIMARY KEY,
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
  }, (err) => {
    if (err) {
      return callback(err)
    }
    
    // Now we create entries for things that ought to be in the database
    c.query('SELECT * FROM ip4_network', [], (err, rows) => {
      if (err) {
        return callback(err)
      }
      
      if (rows.length == 0) {
        // We have no IP4 networks at all
        console.log('Create an IP4 network...')
        
        createIp4Network('10.27.75.0', callback)
      } else {
        callback(null)
      }
      
    })
    
  })
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
  c.query('SELECT (value) FROM kvstore WHERE name = ?', [key], (err, rows) => {
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
  c.query('INSERT INTO kvstore (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?', [key, value, value], (err, rows) => {
    callback(err)
  }) 
}

// Set a config value in the database only if it is unset
function defaultConfig(key, value, callback) {
  c.query('INSERT IGNORE INTO kvstore (name, value) VALUES (?, ?)', [key, value], (err, rows) => {
    callback(err)
  }) 
}

// Set up some default config values, if not set already
function setupDefaultConfig(callback) {
  console.log('Default any unset config values...')
  // Here are a bunch of defaults
  defaults = [
    ['maxUsers', '100'],
    ['servicePrice', '5'],
    ['btcValue', '800']
  ]
  async.each(defaults, (pair, callback) => {
    // Apply each as a default if nothing is set
    defaultConfig(pair[0], pair[1], callback)
  }, callback)
}

// Get the monthly price in BTC that we charge
function getMonthlyPrice(callback) {

  // Grab the service price and the value of bitcoins
  async.map(['servicePrice', 'btcValue'], getConfig, (err, results) => {
    if (err) {
      return callback(err)
    }
    
    // Work out how much we charge a month in BTC
    // Someone just has to keep the database up to date
    var monthlyPrice = acceptor.fiatToBtc(parseFloat(results[0]), parseFloat(results[1]))
    
    // Send it out
    callback(null, monthlyPrice)
    
  })
}

// Daemon function to keep the exchange rate up to date
function checkExchangeRate() {
  acceptor.getExchangeRate((err, exchange_rate) => {
    if (err) {
      // TODO: go into some kind of safe mode if we don't know how much anything is worth?
      
      // Try again in 30 minutes
      setTimeout(checkExchangeRate, 60 * 1000 * 30)
      return
    }
    
    console.log('New bitcoin price: ' + exchange_rate)
    
    setConfig('btcValue', exchange_rate, (err) => {
      if (err) {
        throw err
      }
      
      // Check the price of BTC again in 10 minutes, because it'll change!
      setTimeout(checkExchangeRate, 60 * 1000 * 10)
    })
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

// Look up an account by ID. Call the callback with an error, or null and the
// returned record if the record is present
function getAccountById(id, callback) {
  c.query('SELECT * FROM account WHERE id = ?;', [id], (err, rows) => {
    if (err) {
      return callback(err)
    }
    
    if (rows.length == 0) {
      return callback(new Error('No account found with id ' + id))
    } else {
      // Use the record we found
      return callback(null, rows[0])
    }
    
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

// Add a new IPv4 network, and all of its IPs, to the database, then call the
// callback. network_ip should be like '10.1.1.0'.
function createIp4Network(network_ip, callback) {
  c.query('INSERT INTO ip4_network (network) VALUES (?)', [network_ip], (err, rows) => {
    if (err) {
      return callback(err)
    }
    
    // OK now the network exists, populate it
    
    // First get its ID
    c.query('SELECT id FROM ip4_network WHERE network = ?', [network_ip], (err, rows) => {
      if (err) {
        return callback(err)
      }
      
      if (rows.length != 1) {
        return callback(new Error('Could not find network we just added'))
      }
      
      // OK now we have the actual ID
      var network_id = rows[0].id
      
      // Make an array of all the last octets
      var last_octets = []
      for (var i = 2; i < 255; i++) {
        // Skip .1, which we assign to this machine, and .255, which would be broadcast
        last_octets.push(i)
      }
      
      async.each(last_octets, (last_octet, callback) => {
        // Make up the IP that has this last octet
        
        var ip_address = network_ip.replace(/\.0$/, '.' + last_octet)
      
        c.query('INSERT INTO ip4_address (ip, last_octet, network_id) VALUES (?, ?, ?)', [ip_address, last_octet, network_id],
          (err, rows) => {
          
          if (err) {
            return callback(err)
          }
          
          // After the insert we're done
          callback(null)
        })
      }, callback)
      
    })
    
    
  })
}

// Given the id of an account, a Bitcore privkey, and an expected payment amount
// in BTC, add the Bitcoin address/payment request to the account.
function addBtcAddress(account_id, key, expectedBtc, callback) {
  c.query('INSERT INTO btc_address (account_id, address, privkey, expected_payment) VALUES (?, ?, ?, ?)',
    [account_id, key.toAddress(), key.toString(), acceptor.btcToSatoshis(expectedBtc)], (err, rows) => {
    
    if (err) {
      return callback(err)
    }
    
    console.log('Account #', account_id, ' associated with address ', key.toAddress())
    
    callback(null)
    
  })
}

// Given the BTC address of a payment request, return the record for that
// payment request, or null if there is no such record in the database.
function getBtcAddress(address, callback) {
  c.query('SELECT * FROM btc_address WHERE address = ?;', [address], (err, rows) => {
    
    if (err) {
      return callback(err)
    }
    
    if (rows.length == 0) {
      // No error, but no record either.
      return callback(null, null)
    } else {
      // Use the record we found
      return callback(null, rows[0])
    }
    
  })
}

// Given a string bitcoin address, mark it as paid in the database. On error,
// call the callback with the error. If the statement we ran caused the record
// to flip from unpaid to paid, call the callback with null and true. Else call
// it with null and false.
function markPaid(btcAddress, callback) {

  c.query('UPDATE btc_address SET received = TRUE WHERE address = ? AND received = FALSE', [btcAddress], (err, rows) => {
    if (err) {
      return callback(err)
    }
    
    // We assume that single update statements are atomic, and only one
    // statement trying to do this set operation will affect any rows.
    if (rows.info.affectedRows == 1) {
      // We're the lucky chain of callbacks that gets to actually credit them
      // time.
      return callback(null, true)
    } else {
      // Someone else already marked them as paid
      return callback(null, false)
    }
  })
  
}

// Given a BTC address record object from the database, check if the balance in
// the key is more than was supposed to have been received. If so, go and credit
// the account.
function pollPaymentRequest(btcAddressRecord, callback) {
  // Unpack the database record
  var address = btcAddressRecord.address
  var privkey = acceptor.loadKey(btcAddressRecord.privkey)
  var expectedBtc = acceptor.satoshisToBtc(btcAddressRecord.expected_payment)
  var accountId = btcAddressRecord.account_id

  // Set up a handler for the actual payment
  acceptor.getBalance(address, (err, balance) => {
    if (err) {
      return callback(err)
    }
  
    console.log('Address ', address, ' has balance ', balance, ' and needs ', expectedBtc)
    
    if (balance >= expectedBtc) {
      // They paid enough
      console.log('Address ', address, ' has sufficient balance.')

      // Get the account we will need to credit
      getAccountById(accountId, (err, account) => {
      
        if (err) {
          return callback(err)
        }
      
        // Collect all the money
        acceptor.sweep(privkey, (err, transfered) => {
          if (err) {
            return callback(err)
          }
          
          console.log('Sent ', transfered, ' BTC from ', address)
          
          markPaid(address, (err, have_lock) => {
            // Update the database to reflect payment. This may be called multiple
            // times, but will only actually call its callback with true once.
            
            if (err) {
              return callback(err)
            }
            
            if (!have_lock) {
              // Someone else already marked it paid and must have credited the
              // account.
              return callback(null)
            }
            
            // Otherwise we have the lock so we have to credit the account. TODO: If
            // we die here, the account might not be credited but we still have the
            // money.
            
            // Consider them paid up.
            addTime(account, (err) => {
              if (err) {
                return callback(err)
              }
              
              // If we get through here, we're successful.
              callback(null)
              
            })
          })
          
        })
      })
      
    } else {
        // Not enough money to do anything, but we still need to call the callback.
        callback(null)
    }
  })
}

// Poll all the payment requests that are recent
// Old ones stay in the DB but we don't waste time polling them.
function pollAllPaymentRequests() {
  c.query('SELECT * FROM btc_address WHERE received = FALSE AND requested > (NOW() - INTERVAL 7 DAY)', (err, rows) => {
    // TODO: only look at the ones that aren't too old.
    
    console.log('Polling ' + rows.length + ' invoices...')
    
    async.eachSeries(rows, (row, callback) => {
      // Try each request and see if it's done
      pollPaymentRequest(row, callback)
    }, (err) => {
      if (err) {
        // Something broke
        console.log('Polling error: ',  err);
      } else {
        console.log('Polled ' + rows.length + ' invoices successfully')
      }
      
      // Schedule this to happen again. We can do it relatively infrequently
      // here, and let client invoices poll faster.
      setTimeout(pollAllPaymentRequests, 1000 * 60 * 5)
    })
    
    
  })
}

// Pay up an account for a month. Takes an already-pulled-from-the-database
// account object reflecting the state of the account before the payment was
// made.
function addTime(account, callback) {
  
  // Parse the old paid through date
  var paid_through = moment(account.paid_through);
  
  if (!paid_through.isValid() || paid_through < moment()) {
    // If it's expired or otherwise nonsense, set it paid until now
    paid_through = moment()
  }
  
  // Now add a (standard) month
  paid_through = paid_through.add(31, 'days')
  
  // Turn it into a string SQL can read (ISO 8601)
  paid_string = paid_through.format()
  
  // Update the date. We leave the active flag alone.
  c.query('UPDATE account SET paid_through = CAST(? AS DATETIME) WHERE id = ?',
    [paid_string, account.id], (err, rows) => {
    
    if (err) {
      return callback(err)
    }
    
    console.log('Account ', account.pubkey, ' paid through ', paid_through, ' = ', paid_string)
    if (parseInt(account.active) == 0) {
      // We need to activate the account
      activateAccount(account, callback)
    } else {
      callback(null)
    }
  })
  
}

// Call the callback with null and the assigned IP, which may be null, for the
// given account. Calls the callback with the error if there is an error.
function getIpForAccount(account, callback) {

  if (account.id == undefined) {
    // Not a real account yet
    return callback(null, null)
  }

  c.query('SELECT (ip) FROM ip4_address WHERE account_id = ?', [account.id], (err, rows) => {
    if (err) {
      return callback(err)
    }
    
    // We looked up the IP
    
    if (rows.length == 0) {
      // No assigned IP
      return callback(null, null)
    }
    
    callback(null, rows[0].ip)
  })

}

// Make sure an account has an IP assigned. Calls the callback with null on
// success, or an error on failure.
function ensureIpAssigned(account, callback) {
  c.query('SELECT * FROM ip4_address WHERE account_id = ?', [account.id], (err, rows) => {
    if (err) {
      return callback(err)  
    }
    
    if (rows.length > 0) {
      // We already have an IP
      return callback(null)
    }
    
    // Otherwise we need to go get one
    c.query('UPDATE ip4_address SET account_id = ? WHERE account_id IS NULL LIMIT 1', [account.id], (err, rows) => {
      if (err) {
        return callback(err)
      }
      
      if (rows.info.affectedRows == 1) {
        // We assigned one
        return callback(null)
      }
      
      // We couldn't find a wandering one, so let's make one
      // TODO: add logic to make new IPs
      // For now we just populate the DB at startup
      return callback(new Error('No IP addresses available to allocate'))
      
      
      
    })
    
  })
}

// Activate an account that was inactive. Assign an IP and maybe tell cjdns about it.
function activateAccount(account, callback) {

  // Can't be active without an IP4
  ensureIpAssigned(account, (err) => {
    if (err) {
      return callback(err)
    }

    // Mark the account active
    // TODO: do this last so we will notice if activation failed
    c.query('UPDATE account SET active = TRUE WHERE id = ?', [account.id], (err, rows) => {
      if (err) {
        throw err
      }
      
      console.log('Activated ', account.pubkey)
      
      // Sync tunnels now by waking up the One True Function in charge of tunnels
      tunnelDaemon()
      
      // Everything worked
      callback(null)
      
    })
  })
}

// This function starts up an IP tunnel for the given account record, assuming it has an IP assigned.
// Relevant cjdns call is:
//IpTunnel_allowConnection(publicKeyOfAuthorizedNode, ip4Alloc='', ip6Alloc='', ip4Address=0, ip4Prefix='', ip6Address=0, ip6Prefix='')
function startAccountTunnel(account, callback) {
  // TODO: this can create duplicate IPtunnels in cjdns. These may or may not break things.
  // Instead of creating tunnels all the time, we should do something like ask cjdns what tunnels it has and create the ones that are missing.
  
  // Get the IP
  c.query('SELECT (ip) FROM ip4_address WHERE account_id = ?', [account.id], (err, rows) => {
    if (err) {
      return callback(err)
    }
    
    if (rows.length != 1) {
      // We need to find the IP
      return callback(new Error('No ip found when starting tunnel for account ' + account.id))
    }
    
    var remote_ip = rows[0].ip
    
    // Prepare the cjdns config for the tunnel
    var tunnel_options = {
      ip4Address: remote_ip,
      ip4Prefix: 0, // Advertise the whole Internet
      publicKeyOfAuthorizedNode: account.pubkey
    }
    
    // If cjdns doesn't get back to us soon, complain of failure
    var cjdns_timeout = setTimeout(() => {
      callback(new Error('cjdns admin timeout'))
      callback = (() => {})
    }, 10000)
    
    admin.once(admin.ipTunnel.allowConnection(tunnel_options), (response) => {
      // cjdns got back to us
      clearTimeout(cjdns_timeout)
      
      if(response.data.error != 'none') {
        // cjdns didn't say it worked
        return callback(new Error('Bad response when setting up IP tunnel: ' + JSON.stringify(response)))
      }
      
      // It worked!
      callback(null)
      
    })
    
  })
}

// To be run on startup, or periodically. Start all the active accounts'
// tunnels, except the ones with pubkeys in the given Set.
function startAllActiveAccountTunnels(excluded = undefined, callback) {
  if (excluded == undefined) {
    // By default, don't exclude anything
    excluded = new Set()
  }
  c.query('SELECT * FROM account WHERE active = 1', [], (err, rows) => {
    if (err) {
      return callback(err)
    }
    
    // Start all the tunnels, then feed into our callback.
    async.each(rows, (account, callback) => {
      if (excluded.has(account.pubkey)) {
        // Skip excluded accounts
        return callback(null)
      }
      
      console.log('Start tunnel for account ' + account.id)
      
      // Make tunnels for the others
      startAccountTunnel(account, callback)
    }, callback)
  })
}

function syncActiveTunnels(callback) {
  // If cjdns doesn't get back to us soon, complain of failure
  var cjdns_timeout = setTimeout(() => {
    callback(new Error('cjdns admin timeout'))
    callback = (() => {})
  }, 10000)

  // List all the tunnels (IDs will be stable as new ones are added)
  admin.once(admin.ipTunnel.listConnections(), (response) => {
    // cjdns got back to us
    clearTimeout(cjdns_timeout)
    
    console.log('Found ' + response.data.connections.length + ' open tunnels.')
    
    if(response.data.error != 'none') {
      // cjdns didn't say it worked
      return callback(new Error('Bad response when listing IP tunnels: ' + JSON.stringify(response)))
    }
    
    async.map(response.data.connections, (connection_number, callback) => {
      // We're going to turn the connections into a list of keys that should
      // have tunnels, and null entries.
    
      var cjdns_timeout = setTimeout(() => {
        callback(new Error('cjdns admin timeout'))
        callback = (() => {})
      }, 10000)
    
      admin.once(admin.ipTunnel.showConnection({
        connection: connection_number
      }), (response) => {
        // cjdns got back to us
        clearTimeout(cjdns_timeout)
        
        if(response.data.error != 'none') {
          // cjdns didn't say it worked
          return callback(new Error('Bad response when inspecting IP tunnel ' +
            connection_number + ': ' + JSON.stringify(response)))
        }
        
        if (parseInt(response.data.outgoing) > 0) {
          // Ignore this one since it's outgoing
          return callback(null);
        } else {
          // Make sure this one is supposed to be there
          getAccount(response.data.key, (err, record) => {
            if (err) {
              return callback(err)
            }
            
            if (parseInt(record.active) != 1) {
              // This account shouldn't be active
              
              console.log('Tunnel ' + connection_number + ' for account ' +
                record.id + ' ought not to be open. Closing...')
              
              // Oy with the timeouts already
              var cjdns_timeout = setTimeout(() => {
                callback(new Error('cjdns admin timeout'))
                callback = (() => {})
              }, 10000)
              
              admin.once(admin.ipTunnel.removeConnection({
                connection: connection_number
              }), (response) => {
              
                // cjdns got back to us
                clearTimeout(cjdns_timeout)
                
                if(response.data.error != 'none') {
                  // cjdns didn't say it worked
                  return callback(new Error('Bad response when removing IP tunnel ' +
                    connection_number + ': ' + JSON.stringify(response)))
                }
                
                // It worked!
                callback(null);
                
              })
              
            } else {
              // This tunnel corresponds to an active account.

              // Pass the key back so we can collate and find the accounts with
              // no tunnels yet.
              callback(null, record.pubkey)
            }
            
          })
        }
          
      })
      
    
    }, (err, pubkeys) => {
      if (err) {
        return callback(err)
      }
    
      // Now we have an array of pubkeys and nulls.
      
      // TODO: detect multiple copies of a pubkey and delete one tunnel.
      
      already_open = new Set(pubkeys)
      already_open.delete(null)
      
      // Turn it into a set and start tunnels for everyone not found
      startAllActiveAccountTunnels(already_open, callback)
      
    })
  })
}

// This holds a timeout that fires periodically and tells us to create and destroy tunnels.
var tunnelDaemonTimeout = null;
// You can also call this function and have it create and destroy tunnels right
// now, and it won't step on itself and try to go through the process twice at
// once. The One True Way to make a tunnel is to update the database and then
// call this function.
function tunnelDaemon() {
  if (tunnelDaemonTimeout == null) {
    // Tunnel creation is already in progress
    return
  }
  
  // Otherwise, acquire the cheap-ass lock
  clearTimeout(tunnelDaemonTimeout)
  
  // Now we're the onyl one in the critical section
  syncActiveTunnels((err) => {
    if (err) {
      // Make sure to set up another call to leave the critical section
      tunnelDaemonTimeout = setTimeout(tunnelDaemon, 1000 * 60 * 5)
      throw err
    }
    
    console.log('Tunnels synchronized successfully')
    
    // Tunnels are synced
    tunnelDaemonTimeout = setTimeout(tunnelDaemon, 1000 * 60 * 5)
  })
}

// This function runs periodically to expire accounts. It just has to set them
// inactive and their tunnels will go away.
function expirationDaemon() {
  c.query('UPDATE account SET active = FALSE WHERE paid_through < NOW()', (err, rows) => {
    if (err) {
      throw err
    }
    
    // Otherwise, do nothing with the result
  })
  
  // No need to do this very often
  setTimeout(expirationDaemon, 1000 * 60 * 10)
}

// This function calls the callback with an error if the given key is not a
// valid cjdns pubkey, and with null and the IP address if it is.
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

// Awesome homesite
app.get('/', function (req, res) {
  c.query('SELECT COUNT(*) FROM account WHERE active = TRUE;', null, {useArray: true}, (err, rows) => {
    if (err) {
      throw err
    }
    
    getConfig('servicePrice', (err, fiat_price) => {
      if (err) {
        throw err
      }
    
      getMonthlyPrice((err, price) => {
        if (err) {
          throw err
        }
      
        res.render('index', {
          title: 'Index',
          active_accounts: rows[0][0],
          price: price,
          fiat_price: fiat_price
        })
      })
    })
  })
})

// We want an about page
app.get('/about', function (req, res) {
  res.render('about', {
    title: 'About ProjektVPN',
    server_pubkey: process.env.CJDNS_PUBKEY,
  })
})

// And a nice download page.
app.get('/download', function (req, res) {
  getConfig('servicePrice', (err, fiat_price) => {
    if (err) {
      throw err;
    }
    res.render('download', {
      title: 'Get ProjektVPN',
      fiat_price: fiat_price
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
      return res.render('error', {message: 'Invalid public key ' + pubkey})
    }

    // Otherwise it checks out, so try looking it up
    getAccount(pubkey, (err, record) => {
      if (err) {
        throw err
      }
      
      // See if it has an IPv4 assigned
      getIpForAccount(record, (err, ip4) => {
      
        // Stick the cjdns IP6 in the record
        record['ip6'] = ip6
        
        // And the tunnel IP4 we assigned it
        record['ip4'] = ip4
        
        // Render a page about the account
        res.render('account', {
          account: record,
          server_pubkey: process.env.CJDNS_PUBKEY,
          title: record.pubkey
        })
      })
      
    })
  })
})

// Debugging function to force time onto an account
app.post('/account/:pubkey/force_add_time', function (req, res) {
  var pubkey = req.params['pubkey']

  if (process.env.BTC_NETWORK != 'test') {
    return res.render('error', {
      title: 'Error',
      message: 'Debugging actions only available on testnet'
    })
  }

  // Make sure it's a legit key
  parsePubkey(pubkey, (err, ip6) => {
    
    if (err) {
      // It's not a valid key
      return res.render('error', {
        title: 'Error',
        message: 'Invalid public key ' + pubkey
      })
    }
    
    // Otherwise, it's a valid key. We need to make an account
    getOrCreateAccount(pubkey, (err, account) => {
      if (err) {
        throw err
      }
      
      addTime(account, (err) => {
        if (err) {
          throw err;
        }
        
        // Send user back to the account
        res.redirect('.')
        
      })
      
    })
  })
})

// Add a function to generate an invoice
app.post(['/account/:pubkey/invoice', '/forms/invoice'], function (req, res) {
  
  // Handle both REST-ful and form-compatible routes
  var pubkey = req.params['pubkey'] || req.body['pubkey']
  
  console.log(req.body)

  // Make sure it's a legit key
  parsePubkey(pubkey, (err, ip6) => {
    
    if (err) {
      // It's not a valid key
      return res.render('error', {message: 'Invalid public key ' + pubkey})
    }
    
    // Otherwise, it's a valid key. We need to make an account
    getOrCreateAccount(pubkey, (err, account) => {
      if (err) {
        throw err
      }
      
      // TODO: If they already have a non-expired invoice, maybe extend its
      // expiration or something. Or just go to it.
    
      // Calculate a price quote in BTC for this transaction
      getMonthlyPrice((err, monthlyPrice) => {
        if (err) {
          throw err
        }
        
        // Make a private key to accept payment
        var privkey = acceptor.generateKey()
        
        // Log it in the database
        addBtcAddress(account.id, privkey, monthlyPrice, (err) => {
        
          if (err) {
            throw err
          }
          
          // Send user back to the account
          return res.redirect('/invoice/' + privkey.toAddress().toString())
          
        })
      })
    })
    
  })
})

// And a page to refresh and watch an invoice to see if it has been paid
app.get('/invoice/:address', function (req, res) {
  
  var address = req.params['address']

  // Find the payment request for that address
  getBtcAddress(address, (err, address_record) => {
    if (err) {
      throw err
    }

    if (!address_record) {
      // No invoice exists under that address
      return res.render('error', {
        title: 'Error',
        message: 'No invoice exists for the given address'
      })
    }

    // First we say how to send the page with a given record for the payment
    // request.
    var sendPage = (address_record) => {
    
      if (err) {
        throw err
      }
    
      // Find the account that it belongs to
      getAccountById(address_record.account_id, (err, account) => {
        if (err) {
          throw err
        }
    
        // Now that we can take payment, tell the client
        return res.render('invoice', {
          title: 'Invoice',
          account: account,
          amount: acceptor.satoshisToBtc(address_record.expected_payment),
          btcAddress: address,
          received: address_record.received != 0
        })

      })
    }
    
    // Now we decide if we have to poll the address immediately, before
    // responding to the client.
    if (address_record.received == 0) {
      // If the payment's not in yet, see if we can make it come in.
      console.log('Need to poll')
      pollPaymentRequest(address_record, (err) => {
        if (err) {
          console.log('Error polling in response to user request: ', err)
        }
        
        // Continue along anyway in the event of an error: maybe Blockr is down
        // or we hit our rate limit or something.
        
        // Then see what the database says again and shadow the old
        // address_record with the new one.
        getBtcAddress(address, (err, address_record) => {
          if (err) {
            throw err
          }
          
          if (!address_record) {
            // No invoice exists under that address
            return res.render('error', {
              title: 'Error',
              message: 'No invoice exists for the given address'
            })
          }
          
          // Now actually send the page with the updated view of the database
          sendPage(address_record)
        })
      })
    } else {
      // No need to go poll the address. Just render from what's in the DB now.
      console.log('No need to poll')
      sendPage(address_record)
    }

    
  })
  
})

// And a QR code generator for invoices
app.get('/qr/:address', function (req, res) {
  
  var address = req.params['address']

  // Find the payment request for that address
  getBtcAddress(address, (err, address_record) => {
    if (err) {
      throw err
    }

    res.type('svg')

    if (address_record) {
      // If there's an actual invoice, make a QR code for it
      
      // Where should the code point?
      var btc_url = 'bitcoin:' + address + '?amount=' + acceptor.satoshisToBtc(address_record.expected_payment)
      
      // Make and send the SVG
      var qr_stream = qrImage.image(btc_url, { type: 'svg' })
      qr_stream.pipe(res)
    }
    
    // If there's no invoice we send nothing
  })
})



// Now here's the app startup

app.use(express.static('public'))

// Do some configuring
async.series([upgradeDatabase, setupDefaultConfig], (err) => {
  if (err) {
    // Setup didn't go so well
    throw err
  }
  // Then start the app
  var bind_address = process.env.BIND_ADDRESS || 'localhost'
  var bind_port = process.env.BIND_PORT || 3000
  
  app.listen(bind_port, bind_address, () => {
     
    // Make sure to schedule our cron jobs
    setTimeout(pollAllPaymentRequests, 1)
    tunnelDaemonTimeout = setTimeout(tunnelDaemon, 1)
    setTimeout(checkExchangeRate, 1)
    setTimeout(expirationDaemon, 1)
  
    // Then tell the user
    console.log('ProjektVPN listening on ', bind_address, ' port ', bind_port)
  })
})
  

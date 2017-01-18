// Set up secret credentials
require('dotenv').config()

// We need this to help with the callbacks
var async = require('async')

var express = require('express')
// TODO: handlebars has better integrationa nd the nice {{#if}} syntax
var mustacheExpress = require('mustache-express')
var acceptBitcoin = require('accept-bitcoin')
var cjdnsAdmin = require('cjdns-admin')

// Find our pubkey code stolen from cjdns
var publicToIp6 = require('./publicToIp6')

// Set up express
var app = express()
// Register '.mustache' extension with The Mustache Express
app.engine('mustache', mustacheExpress());
app.set('view engine', 'mustache');
app.set('views', __dirname + '/views');

// Set up accept-bitcoin
var settings = {
  network: process.env.BTC_NETWORK, 
  storePath: 'generatedKeys.txt',
  encryptPrivateKey: false,
  minimumConfirmations: 1
}
var ac = new acceptBitcoin(process.env.BTC_PAYTO, settings)

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
      paid_through DATE,
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
      id INT PRIMARY KEY,
      name VARCHAR(20) UNIQUE NOT NULL,
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
  if (typeof callback === undefined) {
    // Fallback parameter is optional
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
  c.query('INSERT INTO kvstore (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE', [key, value], (err, rows) => {
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
    ["maxUsers", "100"],
    ["servicePrice", "5"],
    ["btcValue", "800"]
  ]
  async.each(defaults, (pair, callback) => {
    // Apply each as a default if nothing is set
    defaultConfig(pair[0], pair[1], callback)
  }, callback)
}

// Look up an account by key. Call the callback with an error if there is one,
// or null and the returned record (which may not be in the database because it
// holds no non-default info)
function getAccount(pubkey, callback) {
  c.query('SELECT * FROM account WHERE pubkey = ?', [pubkey], (err, rows) => {
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
    
    res.render('index', {active_accounts: rows[0][0]})
  })
})

// Add a function to print the info for a pubkey
app.get('/pubkey/:pubkey', function (req, res) {
  
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
      
      // Render a page about the pubkey
      res.render('pubkey', record)
      
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
  })
})
  

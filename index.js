// Set up secret credentials
require('dotenv').config()

var express = require('express')
var acceptBitcoin = require('accept-bitcoin');

// Set up express
var app = express()

// Set up accept-bitcoin
var settings = {
  network: process.env.BTC_NETWORK, 
  storePath: 'generatedKeys.txt',
  encryptPrivateKey: false,
  minimumConfirmations: 1
}
var ac = new acceptBitcoin(process.env.BTC_PAYTO, settings)

// Set up database
var Client = require('mariasql');
var c = new Client({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS
})

app.get('/', function (req, res) {
  c.query('SHOW DATABASES', function(err, rows) {
    if (err)
      throw err
    res.send('Databases:' + JSON.stringify(rows))
  })
})

app.listen(3000, 'localhost', function () {
  console.log('Example app listening on port 3000!')
})

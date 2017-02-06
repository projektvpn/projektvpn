var BitcoinAcceptor = require('./bitcoinAcceptor')

var acceptor = new BitcoinAcceptor('2MyFyrSJcgkppX5aoAAdF66RevM7dcE7nFw', {
  network: 'test',
  minimumConfirmations: 1
})

// Make a privkey
var privkey = acceptor.generateKey()
// Nope, actually load a key we prepared earlier
// Everyone testing gets to use this public private key!
privkey = acceptor.loadKey('aa0becb1b55536d11cc2e69e2a456855714c56da7fce9537a1057a19b47c00ec')

console.log("Privkey: ", privkey)
console.log("Address: ", privkey.toAddress())

function sayBalance(x) {
  // Let's check the balance of this thing
  acceptor.getBalance(x, (err, value) => {
    if (err) {
      throw err
    }
    
    console.log('Got balance of', x, ': ', value)
  })
}

function sayUnspent(x) {
  // Let's check the unspent outputs
  acceptor.getUnspent(x, (err, values) => {
    if (err) {
      throw err
    }
    
    console.log('Got UXTOs of', x, ': ', values)
  })
}

// Say some balances
//sayBalance(privkey)
//sayBalance(privkey.toAddress())
//sayBalance('198aMn6ZYAczwrE5NvNTUMyJ5qkfy4g3Hi')
//sayUnspent('198aMn6ZYAczwrE5NvNTUMyJ5qkfy4g3Hi')

acceptor.getExchangeRate((err, rate) => {
  
  if (err) {
    throw err
  }
  
  console.log('Current exchange rate: $' + rate + ' per BTC')
  
  var fiatPrice = 20
  var btcPrice = acceptor.fiatToBtc(fiatPrice, rate)
  console.log('Please pay $' + fiatPrice + ' = ' + btcPrice + ' BTC to ' + privkey.toAddress())

  acceptor.getBalance(privkey, (err, balance) => {
    
    if (balance >= btcPrice) {
  
      console.log('Found ' + balance + ' BTC >=' + btcPrice + ' BTC. Sweeping...')
      
      // TODO: this is where we would provide the service, so that if our system
      // goes down before moving the funds it's on us.
  
      acceptor.sweep(privkey, (err, amount) => {
        if (err) {
          console.log('Unable to collect funds due to: ' + err)
        } else {
          // Transactiuon sent!
          // Convert back to fiat
          var fiatAmount = acceptor.btcToFiat(amount, rate)
          console.log('Actually collected ' + amount + ' BTC = $' + fiatAmount)
        }
      })
    } else {
      console.log('Currently have only ' + balance + ' BTC')
    }
  })
})


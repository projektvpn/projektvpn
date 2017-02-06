var BitcoinAcceptor = require('./bitcoinAcceptor')

var acceptor = new BitcoinAcceptor('2MyFyrSJcgkppX5aoAAdF66RevM7dcE7nFw', {
  network: 'test'
})

// Make a privkey
var privkey = acceptor.generateKey()
// Nope, actually load a key we prepared earlier
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

acceptor.getBalance(privkey, (err, value) => {
  acceptor.sweep(privkey, (err) => {
    throw err
  })
})


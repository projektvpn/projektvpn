# projektvpn
Meshnet-based VPN Hosting System

**Under Construction!**

ProjektVPN is a turnkey VPN server hosting solution. It runs on a VPN server which forwards user traffic, and handles the collection of payment and the granting and revocation of access to users.

Payment is accepted in bitcoin using the [accept-bitcoin npm module](https://github.com/sagivo/accept-bitcoin), and the actual VPN functionality is provided by [cjdns](https://github.com/cjdelisle/cjdns), using the [cjdns-admin npm module](https://github.com/tcrowe/cjdns-admin).

## Installation

```
curl -sL https://deb.nodesource.com/setup_7.x | sudo -E bash -
sudo apt-get install -y build-essential libczmq-dev mariadb-server nodejs 
git clone https://github.com/projektvpn/projektvpn.git
cd projektvpn
npm install
```

Set up MariaDB:

```
sudo mysql --defaults-file=/etc/mysql/debian.cnf

CREATE DATABASE pvpn;

GRANT ALL PRIVILEGES ON pvpn.* to pvpn@'localhost' IDENTIFIED BY 'pvpn-password'; 

quit;

```


Make a `.env` file with the database credentials and bitcoin configuration:

```
DB_HOST=localhost
DB_USER=pvpn
DB_PASS=pvpn-password
DB_DATABASE=pvpn
BTC_NETWORK=main
BTC_PAYTO=1YourBtcAddressHere
```



## Administration

To get a MariaDB connection:

```
sudo mysql --defaults-file=/etc/mysql/debian.cnf
```

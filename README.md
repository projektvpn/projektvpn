# projektvpn
Meshnet-based VPN Hosting System

**Under Construction!**

ProjektVPN is a turnkey VPN server hosting solution. It runs on a VPN server which forwards user traffic, and handles the collection of payment and the granting and revocation of access to users.

Payment is accepted in bitcoin using the [Blockr API](http://blockr.io/documentation/api), and the actual VPN functionality is provided by [cjdns](https://github.com/cjdelisle/cjdns), using the [cjdns-admin npm module](https://github.com/tcrowe/cjdns-admin).

This repository holds the server software. The client software is available in [projektvpn-client](https://github.com/projektvpn/projektvpn-client).

## Installation

```
curl -sL https://deb.nodesource.com/setup_7.x | sudo -E bash -
sudo apt-get install -y build-essential libczmq-dev mariadb-server nodejs 
git clone https://github.com/projektvpn/projektvpn.git
cd projektvpn
npm install
```

###Set up cjdns:

```
sudo apt-get install mosh nano build-essential nodejs make git devscripts dh-systemd
mkdir cjdns
cd cjdns
git clone https://github.com/cjdelisle/cjdns.git
# Fix service files
cd debian && echo "contrib/systemd/cjdns-resume.service /lib/systemd/system/" >> cjdns.install; cd ..
# Fix systemctl path
sed -i s_/usr/bin/systemctl_`which systemctl`_g contrib/systemd/cjdns-resume.service
debuild
cd ..
sudo dpkg -i cjdns_0.17.1_amd64.deb
```

###Set up MariaDB:

```
sudo mysql --defaults-file=/etc/mysql/debian.cnf

CREATE DATABASE pvpn;

GRANT ALL PRIVILEGES ON pvpn.* to pvpn@'localhost' IDENTIFIED BY 'pvpn-password'; 

quit;

```

### Configure ProjektVPN

Make a `.env` file with the database credentials, cjdns admin credentials, and bitcoin configuration:

```
DB_HOST=localhost
DB_USER=pvpn
DB_PASS=pvpn-password
DB_DATABASE=pvpn
BTC_NETWORK=main
BTC_PAYTO=1YourBtcAddressHere
CJDNS_PUBKEY=yourServerCjdnsPubkeyHere.k
CJDNS_ADMIN_HOST=localhost
CJDNS_ADMIN_PORT=11234
CJDNS_ADMIN_PASS=yourServerCjdnsAdminPasswordHere
```

The `DB_HOST` and `CJDNS_ADMIN_HOST` default to `localhost`, and the `CJDNS_ADMIN_PORT` defaults to `11234`.

### Configure IP routing

By default, ProjektVPN creates a `10.27.75.0/24` subnet where it assigns client IPs. You will need to add `10.27.75.1` as an IP address on your server's `tun0` and configure NAT and routing between there and the Internet. Assuming you get the Internet on eth0, that would look something like:

```
# Tell your system to forward IPv4
echo 'net.ipv4.conf.default.forwarding=1' | sudo tee -a /etc/sysctl.conf

# Configure the IP that your end of the TUN should have
sudo tee -a /etc/network/interfaces <<EOF
auto tun0
iface tun0 inet static
        address 10.27.75.1
        network 10.27.75.0
        netmask 255.255.255.0
        broadcast 10.27.75.255
EOF

# Set up NAT so all the VPN traffic comes out of this server's Internet IP
sudo tee -a /etc/rc.local <<EOF
iptables --wait -t nat -A POSTROUTING -o eth0 -j MASQUERADE
iptables --wait -A FORWARD -i eth0 -o tun0 -m state --state RELATED,ESTABLISHED -j ACCEPT
iptables --wait -A FORWARD -i tun0 -o eth0 -j ACCEPT
EOF

# Restart to apply settings
sudo shutdown -r now
```

## Administration

To get a MariaDB connection:

```
sudo mysql --defaults-file=/etc/mysql/debian.cnf
```

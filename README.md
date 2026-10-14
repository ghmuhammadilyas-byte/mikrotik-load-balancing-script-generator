# MikroTik 2 WAN Load Balancing Script Generator (PCC + failover)

Generate a ready-to-paste **RouterOS 7** script that balances two internet lines on one MikroTik router with **PCC (per-connection classifier)** and **automatic failover** through recursive routes and check hosts.

**Use it online, free, no account:** https://radiusnest.net/mikrotik-load-balancing-script-generator.html

This repository holds the generator itself (lb-generator.js), the same code that runs on that page and in the [RadiusNest MikroTik billing system](https://radiusnest.net/mikrotik-billing-system.html) dashboard. It runs in the browser and in Node.js, with no dependencies.

## What the generated script sets up

- An address on each WAN port: static (address + gateway) or a DHCP client that adds **no** default route of its own
- A check host per WAN (8.8.8.8 through WAN1, 1.1.1.1 through WAN2 by default), pinged every 10 seconds
- Recursive default routes in three routing tables (main, to-wan1, to-wan2): a route only stays active while its line really reaches the internet, so failover works even when the port stays up
- Masquerade (NAT) on each WAN
- Mangle rules: connections are shared between the WANs by PCC (both-addresses), with any ratio from 1:1 to 9:1 either way; replies leave on the WAN they came in on
- Hotspot, PPPoE, VLAN and bridge clients are all balanced without naming them; traffic between private networks is left alone
- FastTrack is turned off, because fast-tracked packets skip the mangle rules

Everything the script adds is tagged RN-LB, so running it again replaces the previous run and removes nothing else. Other static default routes in the main table are disabled, not deleted.

## Use in the browser

~~~html
<script src="lb-generator.js"></script>
<script>
  const answers = {
    wan1_interface: 'ether1', wan1_mode: 'static', wan1_address: '203.0.113.2/30', wan1_gateway: '203.0.113.1',
    wan2_interface: 'ether2', wan2_mode: 'dhcp',
    weight1: 1, weight2: 1            // share of new connections, 1-9 each
    // check1: '8.8.8.8', check2: '1.1.1.1'   // optional check hosts
  };
  const rsc = RNLoadBalance.script(answers);   // the .rsc text
  const name = RNLoadBalance.fileName(RNLoadBalance.validate(answers));
</script>
~~~

## Use in Node.js

~~~js
const fs = require('fs');
const lb = require('./lb-generator.js');

const answers = {
  wan1_interface: 'ether1', wan1_mode: 'dhcp',
  wan2_interface: 'ether2', wan2_mode: 'dhcp',
  weight1: 2, weight2: 1
};
fs.writeFileSync(lb.fileName(lb.validate(answers)), lb.script(answers));
~~~

Invalid answers throw an error whose message names the field, for example "wan1_gateway: is not inside 203.0.113.0/30".

## Apply it on the router

1. Open Winbox, then **New Terminal**.
2. Paste the whole script and press Enter.
3. Check **IP > Routes**: both default routes become active within a minute.
4. Test: in **IP > Firewall > Connections**, the Connection Mark column alternates between wan1-conn and wan2-conn.
5. Failover: unplug WAN1 and new connections move to WAN2 within about 30 seconds.

Back up the router first (Files > Backup), as with any change to routing.

## Guides

- [How MikroTik PCC load balancing works](https://radiusnest.net/mikrotik-load-balancing-pcc.html)
- [MikroTik failover with recursive routes](https://radiusnest.net/mikrotik-failover.html)
- [All MikroTik guides](https://radiusnest.net/guides.html)

## About RadiusNest

[RadiusNest](https://radiusnest.net/) is a cloud **MikroTik billing system** for hotspot and PPPoE ISPs: packages, vouchers, renewals, resellers, sales reports and customer self-service, on RouterOS v6 and v7, with no server to run and no public IP needed. Read how it works on the [MikroTik billing system page](https://radiusnest.net/mikrotik-billing-system.html).

MikroTik and RouterOS are trademarks of MikroTik SIA. This project is independent and not affiliated with MikroTik.

## License

MIT - see [LICENSE](LICENSE).

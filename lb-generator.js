/* RadiusNest - MikroTik 2 WAN load balancing script generator.
   This file is the dashboard's own generator (src/services/loadbalance.js), unchanged, with
   the three things it needs from the server supplied below. Runs in the browser and in Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RNLoadBalance = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  class HttpError extends Error { constructor(status, message, details) { super(message); this.status = status; this.details = details; } }
  const config = { appName: 'RadiusNest' };
  const badV = (field, msg) => new HttpError(400, `${field}: ${msg}`, { field });
  const isIPv4 = (s) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) && s.split('.').every((p) => Number(p) <= 255 && String(Number(p)) === p);
  // the validators the generator uses, as the dashboard's src/lib/validate.js has them
  const v = {
    str(value, field, { min = 0, max = 255, pattern, patternMsg, optional = false, def = '' } = {}) {
      if (value === undefined || value === null) { if (optional) return def; value = ''; }
      if (typeof value !== 'string' && typeof value !== 'number') throw badV(field, 'must be text');
      const s = String(value).trim();
      if (s.length < min) throw badV(field, min === 1 ? 'is required' : `must be at least ${min} characters`);
      if (s.length > max) throw badV(field, `must be at most ${max} characters`);
      if (pattern && s !== '' && !pattern.test(s)) throw badV(field, patternMsg || 'has an invalid format');
      return s;
    },
    int(value, field, { min = 0, max = 2147483647, optional = false, def = 0 } = {}) {
      if (value === undefined || value === null || value === '') { if (optional) return def; throw badV(field, 'is required'); }
      const n = Number(value);
      if (!Number.isInteger(n)) throw badV(field, 'must be a whole number');
      if (n < min || n > max) throw badV(field, `must be between ${min} and ${max}`);
      return n;
    },
    oneOf(value, field, options, { optional = false, def } = {}) {
      if ((value === undefined || value === null || value === '') && optional) return def;
      if (!options.includes(value)) throw badV(field, `must be one of: ${options.join(', ')}`);
      return value;
    },
    ipv4(value, field, { optional = true } = {}) {
      const s = v.str(value, field, { max: 15, optional, def: '' });
      if (s !== '' && !isIPv4(s)) throw badV(field, 'must be an IPv4 address');
      return s;
    },
  };

/* 2 WAN load balancing with automatic failover, as a RouterOS 7 script an ISP downloads
 * and pastes into a MikroTik terminal.
 *
 * The method is the one proven on a lab router (and shown in the RadiusNest video):
 *   - both WAN ports get an address (static, or a DHCP client that adds NO default route)
 *   - a "check host" route per WAN: 8.8.8.8/32 via the WAN1 gateway, 1.1.1.1/32 via the
 *     WAN2 gateway (scope 10)
 *   - recursive default routes whose gateway IS the check host (target-scope 11,
 *     check-gateway=ping): the route lives only while its WAN really reaches the internet
 *       main:    via 8.8.8.8 distance 1, via 1.1.1.1 distance 2   (new router traffic, failover)
 *       to-wan1: via 8.8.8.8 distance 1, via 1.1.1.1 distance 2
 *       to-wan2: via 1.1.1.1 distance 1, via 8.8.8.8 distance 2
 *   - masquerade on each WAN
 *   - mangle: a connection that came in on a WAN is marked for that WAN; a new connection
 *     from the LAN side is marked wan1-conn or wan2-conn by per-connection-classifier
 *     (both addresses, so one customer<->server pair always takes the same WAN); marked
 *     connections are routed through their table (prerouting for the LAN, output for the
 *     router's own replies).
 *
 * The LAN side is "anything that did not come in on a WAN" (in-interface-list=!RN-LB-WAN),
 * so hotspot, PPPoE (<pppoe-user> interfaces), VLANs and bridges are all balanced without
 * naming them. Destinations that are the router itself or a private network stay out of
 * the balancing (dst-address-type=!local, dst-address-list=!RN-LB-local), so routing
 * between the router's own networks keeps working.
 *
 * Everything the script adds carries the comment "RN-LB", so running it again first
 * removes the previous run and nothing else of the ISP's. No database needed: tested by
 * test/loadbalance.js.
 */

const TAG = 'RN-LB';
const LIST_WAN = 'RN-LB-WAN';
const LIST_LOCAL = 'RN-LB-local';
const MAX_WEIGHT = 9;

function bad(field, msg) {
  return new HttpError(400, `${field}: ${msg}`, { field });
}

function ipToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim());
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

// Interface names as MikroTik allows them in practice: letters, digits, space and . _ -
function ifaceName(value, field) {
  return v.str(value, field, {
    min: 1, max: 64,
    pattern: /^[A-Za-z0-9][A-Za-z0-9 ._\-]*$/,
    patternMsg: 'may only contain letters, numbers, spaces and . _ -',
  });
}

// "203.0.113.2/30" -> { cidr, ip (int), bits, network, broadcast }
function parseCidr(value, field) {
  const s = v.str(value, field, { min: 1, max: 18 });
  const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/.exec(s);
  const ip = m ? ipToInt(m[1]) : null;
  if (ip === null) throw bad(field, 'must be the WAN address with its prefix, like 203.0.113.2/30');
  const bits = Number(m[2]);
  if (bits < 8 || bits > 30) throw bad(field, 'the /prefix must be between /8 and /30');
  const size = 2 ** (32 - bits);
  const network = (ip & (~(size - 1) >>> 0)) >>> 0;
  const broadcast = (network + size - 1) >>> 0;
  if (ip === network || ip === broadcast) throw bad(field, 'is the network or broadcast address, not an address the router can use');
  return { cidr: `${m[1]}/${bits}`, ip, bits, network, broadcast };
}

function wanOf(b, n) {
  const p = `wan${n}_`;
  const out = {
    interface: ifaceName(b[`${p}interface`], `${p}interface`),
    mode: v.oneOf(b[`${p}mode`], `${p}mode`, ['static', 'dhcp'], { optional: true, def: 'static' }),
    address: '',
    gateway: '',
  };
  if (out.mode === 'static') {
    const c = parseCidr(b[`${p}address`], `${p}address`);
    const gw = v.ipv4(b[`${p}gateway`], `${p}gateway`, { optional: true });
    if (!gw) throw bad(`${p}gateway`, 'is required for a static address: the address your provider told you to use as the gateway');
    const g = ipToInt(gw);
    if (g === c.ip) throw bad(`${p}gateway`, 'is the same as the WAN address; the gateway is the provider\'s address, not the router\'s');
    if (g < c.network || g > c.broadcast || g === c.network || g === c.broadcast) throw bad(`${p}gateway`, `is not inside ${c.cidr}; the gateway must be in the same network as the WAN address`);
    out.address = c.cidr;
    out.gateway = gw;
  }
  return out;
}

function checkHost(value, field, def) {
  const s = v.ipv4(value, field, { optional: true });
  if (!s) return def;
  const n = ipToInt(s);
  const priv = (n >>> 24) === 10 || (n >>> 24) === 127 || ((n >>> 20) === (172 << 4) + 1) || (n >>> 16) === (192 << 8) + 168 || (n >>> 24) === 0;
  if (priv) throw bad(field, 'must be a public address on the internet that answers ping (for example 8.8.8.8 or 1.1.1.1)');
  return s;
}

/** Checks an ISP's answers; returns the clean object the script is built from. */
function validate(body = {}) {
  const b = body || {};
  const wan1 = wanOf(b, 1);
  const wan2 = wanOf(b, 2);
  if (wan1.interface.toLowerCase() === wan2.interface.toLowerCase()) throw bad('wan2_interface', 'must be a different port from WAN1');
  if (wan1.mode === 'static' && wan2.mode === 'static' && wan1.address === wan2.address) throw bad('wan2_address', 'is the same as the WAN1 address');
  const weight1 = v.int(b.weight1, 'weight1', { min: 1, max: MAX_WEIGHT, optional: true, def: 1 });
  const weight2 = v.int(b.weight2, 'weight2', { min: 1, max: MAX_WEIGHT, optional: true, def: 1 });
  const check1 = checkHost(b.check1, 'check1', '8.8.8.8');
  const check2 = checkHost(b.check2, 'check2', '1.1.1.1');
  if (check1 === check2) throw bad('check2', 'must be a different address from the WAN1 check host');
  return { wan1, wan2, weight1, weight2, check1, check2 };
}

// a value inside a double-quoted RouterOS string: the validation above already limits
// every value to safe characters; this is the last line of defence
function q(value) {
  const s = String(value);
  if (!/^[A-Za-z0-9 ./_\-]*$/.test(s)) throw new Error('unsafe value for RouterOS script');
  return `"${s}"`;
}

function clean(text, max = 60) {
  return String(text || '').replace(/[^A-Za-z0-9 ._\-]/g, '').slice(0, max);
}

// A block the router runs as one step: logs its own success or refusal, never stops the
// rest of the script.
function step(what, lines) {
  return [
    ':do {',
    ...lines.map((l) => `  ${l}`),
    `  :log info "${TAG}: ${what} - ok"`,
    `} on-error={ :log warning "${TAG}: ${what} - FAILED, check it by hand" }`,
    '',
  ];
}

// How the WAN gets its address, as the script and the comments describe it
function wanWords(w) {
  return w.mode === 'dhcp' ? 'DHCP client' : `static ${w.address}, gateway ${w.gateway}`;
}

// The lines that give one WAN its address and leave the gateway in $gwN. Static: the
// address is added (if not there yet) and the gateway is known. DHCP: a client that adds
// no default route; its gateway is read once it is bound, and the client's own script
// keeps the check-host route pointed at the gateway whenever the lease changes.
function wanLines(w, n, host) {
  const comment = `${TAG} WAN${n}`;
  const iface = q(w.interface);
  if (w.mode === 'static') {
    return step(`WAN${n} address (${w.interface})`, [
      // a DHCP client on the same port would add its own address and default route
      `/ip dhcp-client remove [find interface=${iface}]`,
      `:if ([:len [/ip address find address=${q(w.address)} interface=${iface}]] = 0) do={`,
      `  /ip address add address=${q(w.address)} interface=${iface} comment="${comment}"`,
      '}',
      `:set gw${n} "${w.gateway}"`,
    ]);
  }
  // the client's script runs on every lease change ($bound is 1 when a lease arrives)
  const onBound = `:if (\\$bound=1) do={ /ip route set [find comment=\\"${TAG} WAN${n} check host\\"] gateway=\\$\\"gateway-address\\" }`;
  return step(`WAN${n} DHCP client (${w.interface})`, [
    `:if ([:len [/ip dhcp-client find interface=${iface}]] = 0) do={`,
    `  /ip dhcp-client add interface=${iface} add-default-route=no use-peer-dns=yes disabled=no comment="${comment}"`,
    '  :delay 3s',
    '}',
    `/ip dhcp-client set [find interface=${iface}] add-default-route=no disabled=no script="${onBound}"`,
    `:set gw${n} [/ip dhcp-client get [find interface=${iface}] gateway]`,
    `:if ([:len $gw${n}] = 0) do={ :set gw${n} ${iface} }`,
    `:put "WAN${n}: ${w.interface} by DHCP, gateway now $gw${n} (the check-host route to ${host} follows the lease)"`,
  ]);
}

/** The script. `body` is the ISP's answers as they came in (checked here again); `tenantName` only appears in the header. */
function script(body, tenantName) {
  const s = validate(body);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const { wan1, wan2, check1, check2, weight1, weight2 } = s;
  const n = weight1 + weight2;
  const share = weight1 === weight2 ? 'half and half' : `${weight1} share${weight1 > 1 ? 's' : ''} on WAN1 for every ${weight2} on WAN2`;

  const out = [
    '# ================================================================',
    `#  ${clean(config.appName)} - 2 WAN LOAD BALANCING with automatic failover`,
    tenantName ? `#  ISP: ${clean(tenantName)}` : null,
    `#  WAN1: ${wan1.interface} (${wanWords(wan1)}) - the main line`,
    `#  WAN2: ${wan2.interface} (${wanWords(wan2)}) - takes over when WAN1 is down`,
    `#  Share of new connections: ${weight1}:${weight2} (${share})`,
    `#  Check hosts: ${check1} through WAN1, ${check2} through WAN2 (pinged every 10 seconds)`,
    `#  Generated: ${now}`,
    '#',
    '#  For RouterOS 7. Open Winbox > New Terminal, paste the whole script, press Enter.',
    '#  Running it again is safe: everything it adds is tagged "RN-LB" and is replaced;',
    '#  nothing else of yours is removed.',
    '#',
    '#  What it changes besides adding its own rules:',
    '#   - other static default routes in the main table are DISABLED (they would fight',
    '#     the load-balancing routes); a DHCP client on a WAN port stops adding one',
    '#   - FastTrack is turned off: fast-tracked packets skip the mangle rules, so the',
    '#     balancing would silently stop working with it on',
    '# ================================================================',
    '',
    '# One block, so the two gateway variables below are visible to every step (a terminal',
    '# runs each top-level line on its own; a variable set outside a block is not seen inside).',
    '{',
    ':local gw1 ""',
    ':local gw2 ""',
    '',
    '# 1) Remove what an earlier run of this script added (nothing else)',
    ...step('cleanup of the previous run', [
      `/ip firewall mangle remove [find comment~"^${TAG}"]`,
      `/ip firewall nat remove [find comment~"^${TAG}"]`,
      `/ip firewall address-list remove [find list="${LIST_LOCAL}"]`,
      `/ip route remove [find comment~"^${TAG}"]`,
      `/interface list member remove [find list="${LIST_WAN}"]`,
    ]),
    '# 2) The two WAN ports, as a list the mangle rules can refer to',
    ...step('WAN interface list', [
      `:if ([:len [/interface list find name="${LIST_WAN}"]] = 0) do={ /interface list add name="${LIST_WAN}" comment="${TAG}" }`,
      `/interface list member add list="${LIST_WAN}" interface=${q(wan1.interface)} comment="${TAG} WAN1"`,
      `/interface list member add list="${LIST_WAN}" interface=${q(wan2.interface)} comment="${TAG} WAN2"`,
    ]),
    '# 3) Addresses on the WAN ports. Neither WAN may add a default route of its own:',
    '#    the routes below decide where traffic goes.',
    ...wanLines(wan1, 1, check1),
    ...wanLines(wan2, 2, check2),
    '# 4) Other static default routes in the main table are disabled, not deleted',
    ...step('disable other default routes', [
      '/ip route set [find where dst-address="0.0.0.0/0" and !dynamic and routing-table=main] disabled=yes',
    ]),
    '# 5) One routing table per WAN',
    ...step('routing tables', [
      ':if ([:len [/routing table find name="to-wan1"]] = 0) do={ /routing table add name="to-wan1" fib }',
      ':if ([:len [/routing table find name="to-wan2"]] = 0) do={ /routing table add name="to-wan2" fib }',
    ]),
    `# 6) Check hosts: ${check1} is reached only through WAN1, ${check2} only through WAN2.`,
    '#    The default routes point at these hosts (recursive) and ping them, so a route',
    '#    disappears when its line cannot reach the internet - even if the port stays up.',
    ...step('check-host routes', [
      `/ip route add dst-address=${check1}/32 gateway=$gw1 scope=10 comment="${TAG} WAN1 check host"`,
      `/ip route add dst-address=${check2}/32 gateway=$gw2 scope=10 comment="${TAG} WAN2 check host"`,
    ]),
    '# 7) Default routes: main (the router itself and unmarked traffic), to-wan1, to-wan2.',
    '#    Distance 1 is the normal way out, distance 2 the backup.',
    ...step('default routes', [
      `/ip route add dst-address=0.0.0.0/0 gateway=${check1} check-gateway=ping distance=1 target-scope=11 routing-table=main comment="${TAG} main WAN1"`,
      `/ip route add dst-address=0.0.0.0/0 gateway=${check2} check-gateway=ping distance=2 target-scope=11 routing-table=main comment="${TAG} main WAN2 backup"`,
      `/ip route add dst-address=0.0.0.0/0 gateway=${check1} check-gateway=ping distance=1 target-scope=11 routing-table=to-wan1 comment="${TAG} to-wan1"`,
      `/ip route add dst-address=0.0.0.0/0 gateway=${check2} check-gateway=ping distance=2 target-scope=11 routing-table=to-wan1 comment="${TAG} to-wan1 backup"`,
      `/ip route add dst-address=0.0.0.0/0 gateway=${check2} check-gateway=ping distance=1 target-scope=11 routing-table=to-wan2 comment="${TAG} to-wan2"`,
      `/ip route add dst-address=0.0.0.0/0 gateway=${check1} check-gateway=ping distance=2 target-scope=11 routing-table=to-wan2 comment="${TAG} to-wan2 backup"`,
    ]),
    '# 8) Internet sharing (NAT) on each WAN',
    ...step('NAT', [
      `:if ([:len [/ip firewall nat find where chain=srcnat and action=masquerade and out-interface=${q(wan1.interface)}]] = 0) do={`,
      `  /ip firewall nat add chain=srcnat action=masquerade out-interface=${q(wan1.interface)} comment="${TAG} WAN1"`,
      '}',
      `:if ([:len [/ip firewall nat find where chain=srcnat and action=masquerade and out-interface=${q(wan2.interface)}]] = 0) do={`,
      `  /ip firewall nat add chain=srcnat action=masquerade out-interface=${q(wan2.interface)} comment="${TAG} WAN2"`,
      '}',
    ]),
    '# 9) Private networks are never balanced: traffic between the router\'s own networks',
    '#    (hotspot, PPPoE, VLANs) keeps using the main table',
    ...step('local networks list', [
      `/ip firewall address-list add list="${LIST_LOCAL}" address=10.0.0.0/8 comment="${TAG}"`,
      `/ip firewall address-list add list="${LIST_LOCAL}" address=172.16.0.0/12 comment="${TAG}"`,
      `/ip firewall address-list add list="${LIST_LOCAL}" address=192.168.0.0/16 comment="${TAG}"`,
    ]),
    '# 10) Mangle: which WAN a connection belongs to, and the route that follows from it',
  ];
  const mangle = [
    `/ip firewall mangle add chain=prerouting in-interface=${q(wan1.interface)} connection-mark=no-mark action=mark-connection new-connection-mark=wan1-conn passthrough=yes comment="${TAG} in on WAN1"`,
    `/ip firewall mangle add chain=prerouting in-interface=${q(wan2.interface)} connection-mark=no-mark action=mark-connection new-connection-mark=wan2-conn passthrough=yes comment="${TAG} in on WAN2"`,
  ];
  for (let i = 0; i < n; i += 1) {
    const w = i < weight1 ? 1 : 2;
    mangle.push(`/ip firewall mangle add chain=prerouting in-interface-list=!${LIST_WAN} connection-mark=no-mark dst-address-type=!local dst-address-list=!${LIST_LOCAL} per-connection-classifier=both-addresses:${n}/${i} action=mark-connection new-connection-mark=wan${w}-conn passthrough=yes comment="${TAG} LAN share ${i + 1} of ${n} -> WAN${w}"`);
  }
  mangle.push(
    `/ip firewall mangle add chain=prerouting in-interface-list=!${LIST_WAN} connection-mark=wan1-conn action=mark-routing new-routing-mark=to-wan1 passthrough=no comment="${TAG} route WAN1"`,
    `/ip firewall mangle add chain=prerouting in-interface-list=!${LIST_WAN} connection-mark=wan2-conn action=mark-routing new-routing-mark=to-wan2 passthrough=no comment="${TAG} route WAN2"`,
    `/ip firewall mangle add chain=output connection-mark=wan1-conn action=mark-routing new-routing-mark=to-wan1 passthrough=no comment="${TAG} router replies WAN1"`,
    `/ip firewall mangle add chain=output connection-mark=wan2-conn action=mark-routing new-routing-mark=to-wan2 passthrough=no comment="${TAG} router replies WAN2"`,
  );
  out.push(
    ...step('mangle rules', mangle),
    '# 11) FastTrack would let packets skip the mangle rules',
    ...step('turn FastTrack off', [
      '/ip firewall filter set [find where action=fasttrack-connection] disabled=yes',
    ]),
    `:log info "${TAG}: 2 WAN load balancing applied (WAN1 ${wan1.interface}, WAN2 ${wan2.interface}, ${weight1}:${weight2})"`,
    `:put "Done. IP > Routes: both default routes should be active (AS) within a minute. One that shows 'unreachable' means its WAN cannot reach its check host (${check1} / ${check2})."`,
    ':put "Test: open Firewall > Connections from a LAN device with a few connections open - the Connection Mark column alternates between wan1-conn and wan2-conn."',
    ':put "Failover: unplug WAN1 - new connections use WAN2 within about 30 seconds; plug it back and they return to WAN1."',
    '}',
    '',
  );
  return out.filter((l) => l !== null).join('\n');
}

function fileName(s) {
  return `radiusnest-2wan-${clean(s.wan1.interface, 20).replace(/ /g, '_') || 'wan1'}-${clean(s.wan2.interface, 20).replace(/ /g, '_') || 'wan2'}.rsc`;
}

return { validate, script, fileName, TAG };

}));

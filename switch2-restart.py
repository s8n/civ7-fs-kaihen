#!/usr/bin/env python3
"""Restart (or power off) the Switch 2 over the LAN.

    python3 switch2-restart.py                  find the console, restart it
    python3 switch2-restart.py 192.168.1.50     restart that console
    python3 switch2-restart.py --shutdown       power off instead
    python3 switch2-restart.py --probe          only check it would work
    python3 switch2-restart.py --yes            do not ask first

How it works: this goes through the CivSwitch JS loader, which listens on TCP 9026 while Civ VII is open. 
The script sends a small JavaScript payload that looks up the system's own nn::oe::RequestToReboot (or RequestToShutdown) 
in the SDK export table and calls it.

So Civ VII must be running with the loader up.
"""
import argparse
import concurrent.futures
import socket
import sys
import time

LOADER_PORT = 9026
SYMBOLS = {
    "restart": "_ZN2nn2oe15RequestToRebootEv",
    "shutdown": "_ZN2nn2oe17RequestToShutdownEv",
}

# Runs in the loader's scope, where call_rop, read8/32/64, sdk_base and log exist.
PAYLOAD = r"""
(function () {
    var NAME = "%(symbol)s", PROBE = %(probe)s, ACTION = "%(action)s";
    function info(base) {
        var mod = base + read32(base + 4n);
        if (read32(mod) !== 0x30444f4dn) throw Error("SDK module has no MOD0 header");
        var dynamic = mod + BigInt.asIntN(32, read32(mod + 4n)), tags = {};
        for (var i = 0; i < 128; i++) {
            var tag = Number(read64(dynamic + BigInt(i * 16))); if (!tag) break;
            var value = read64(dynamic + BigInt(i * 16 + 8));
            tags[tag] = (tag === 4 || tag === 5 || tag === 6) && value < base ? base + value : value;
        }
        if (!tags[4] || !tags[5] || !tags[6]) throw Error("SDK export table unavailable");
        return { hash: tags[4], strings: tags[5], symbols: tags[6],
                 buckets: Number(read32(tags[4])), count: Number(read32(tags[4] + 4n)) };
    }
    function cstring(p, limit) {
        var text = "";
        for (var i = 0; i < limit; i++) { var c = Number(read8(p + BigInt(i))); if (!c) break; text += String.fromCharCode(c); }
        return text;
    }
    function resolve(m, name) {
        var hash = 0;
        for (var j = 0; j < name.length; j++) {
            hash = ((hash << 4) + name.charCodeAt(j)) >>> 0; var high = hash & 0xf0000000;
            if (high) hash ^= high >>> 24; hash = (hash & ~high) >>> 0;
        }
        var index = Number(read32(m.hash + 8n + BigInt((hash %% m.buckets) * 4)));
        for (var k = 0; index && k < m.count; k++) {
            if (index >= m.count) break;
            var sym = m.symbols + BigInt(index * 24);
            if (cstring(m.strings + read32(sym), 256) === name) { var off = read64(sym + 8n); return off ? sdk_base + off : null; }
            index = Number(read32(m.hash + 8n + BigInt((m.buckets + index) * 4)));
        }
        return null;
    }
    var m = info(sdk_base), fn = resolve(m, NAME);
    if (!fn) {
        log("SWITCH2-RESTART: MISSING " + NAME);
        if (PROBE) {
            // Slow full scan, only on request: list anything that looks related.
            var hits = 0;
            for (var i = 1; i < m.count && hits < 20; i++) {
                var p = m.strings + read32(m.symbols + BigInt(i * 24));
                if (Number(read8(p + 5n)) !== 0x6e) continue;            // "_ZN2nn" prefix check
                var s = cstring(p, 96);
                if (/Reboot|Shutdown|RequestToSleep/.test(s)) { log("SWITCH2-RESTART: CANDIDATE " + s); hits++; }
            }
            log("SWITCH2-RESTART: SCAN-DONE " + hits);
        }
        return;
    }
    log("SWITCH2-RESTART: FOUND " + NAME + " at sdk+0x" + (fn - sdk_base).toString(16));
    if (PROBE) return;
    log("SWITCH2-RESTART: CALLING " + ACTION);
    var result = call_rop(fn);
    log("SWITCH2-RESTART: RETURNED " + String(result));
})();
"""


def local_prefix():
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("10.255.255.255", 1))  # no packet is sent for UDP connect
        return probe.getsockname()[0].rsplit(".", 1)[0]
    finally:
        probe.close()


def port_open(host, port, timeout=0.6):
    try:
        socket.create_connection((host, port), timeout=timeout).close()
        return True
    except OSError:
        return False


def discover(port):
    prefix = local_prefix()
    hosts = ["%s.%d" % (prefix, n) for n in range(1, 255)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=64) as pool:
        flags = list(pool.map(lambda h: port_open(h, port), hosts))
    return [h for h, up in zip(hosts, flags) if up], prefix


def send(host, port, code, timeout):
    """Loader protocol: UTF-8 JS, half-close, then the log stream until close."""
    sock = socket.create_connection((host, port), timeout=8)
    sock.sendall(code.encode("utf-8"))
    sock.shutdown(socket.SHUT_WR)
    sock.settimeout(timeout)
    data = b""
    try:
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            data += chunk
    except (socket.timeout, OSError):
        pass
    sock.close()
    return data.decode("utf-8", "replace")


def main():
    ap = argparse.ArgumentParser(description="Restart Switch 2 over the LAN via the CivSwitch loader.")
    ap.add_argument("host", nargs="?", help="console IP (found automatically when omitted)")
    ap.add_argument("--shutdown", action="store_true", help="power off instead of restarting")
    ap.add_argument("--probe", action="store_true", help="check the system call exists; do not call it")
    ap.add_argument("--yes", "-y", action="store_true", help="skip the confirmation prompt")
    ap.add_argument("--port", type=int, default=LOADER_PORT)
    args = ap.parse_args()
    action = "shutdown" if args.shutdown else "restart"

    host = args.host
    if not host:
        print("Looking for a console with the loader on port %d..." % args.port)
        found, prefix = discover(args.port)
        if not found:
            print("No console found on %s.0/24. Open Civ VII and start the CivSwitch loader "
                  "(it must be waiting on TCP %d), or pass the console IP." % (prefix, args.port))
            return 1
        if len(found) > 1:
            print("More than one host answers on that port: %s. Pass the one you mean." % ", ".join(found))
            return 1
        host = found[0]
        print("Found %s" % host)
    elif not port_open(host, args.port, timeout=3):
        print("%s is not listening on TCP %d. Civ VII with the CivSwitch loader has to be running." % (host, args.port))
        return 1

    if not args.probe and not args.yes:
        answer = input("%s the Switch 2 at %s now? Unsaved game progress is lost. [y/N] " % (action.capitalize(), host))
        if answer.strip().lower() not in ("y", "yes"):
            print("Cancelled.")
            return 1

    code = PAYLOAD % {"symbol": SYMBOLS[action], "probe": "true" if args.probe else "false", "action": action}
    output = send(host, args.port, code, timeout=90 if args.probe else 15)
    lines = [l.strip() for l in output.replace("\r", "").split("\n") if "SWITCH2-RESTART:" in l]
    for line in lines:
        print("  console: " + line.split("SWITCH2-RESTART:", 1)[1].strip())
    if not lines and output.strip():
        print("  console said: " + output.strip()[-400:])

    if any("MISSING" in l for l in lines):
        print("This game's SDK does not export %s, so the %s request is not available this way." % (SYMBOLS[action], action))
        if not args.probe:
            print("Run again with --probe to list related system calls that do exist.")
        return 2
    if args.probe:
        if any("FOUND" in l for l in lines):
            print("Probe OK: the %s call is present. Run without --probe to use it." % action)
            return 0
        print("Probe gave no answer; the loader may be busy with another payload.")
        return 2
    if any("RETURNED" in l for l in lines):
        print("The system call returned instead of taking the console down; the %s was refused." % action)
        return 3

    # Confirm from the outside: the loader port should stop answering.
    deadline = time.time() + 30
    while time.time() < deadline:
        if not port_open(host, args.port, timeout=1):
            print("Console stopped answering: %s is under way." % action)
            return 0
        time.sleep(1)
    print("Request sent, but the console still answers on port %d after 30 s. It may not have %s." %
          (args.port, "shut down" if args.shutdown else "restarted"))
    return 3


if __name__ == "__main__":
    sys.exit(main())

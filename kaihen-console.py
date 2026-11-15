#!/usr/bin/env python3
"""Small menu for repeated kaiHEN attempts.

    python3 kaihen-console.py                  console at 192.168.2.1
    python3 kaihen-console.py 192.168.1.50     another address

  Enter   run kaiHEN with 10 waves
  1       install the trigger save, then restart the console
  q       quit
"""
import os
import subprocess
import sys

IP = sys.argv[1] if len(sys.argv) > 1 else "192.168.2.1"
HERE = os.path.dirname(os.path.abspath(__file__))
KAIHEN_REPO = os.environ.get("KAIHEN_REPO", os.path.expanduser("./"))
KAIHEN_DIR = os.environ.get("KAIHEN_DIR", "./kaiHEN-20261114c")
SAVE_TOOLS = os.environ.get("KAIHEN_SAVE_TOOLS", os.path.expanduser("./save-tools"))
RESTART = os.environ.get("KAIHEN_RESTART", os.path.join(HERE, "./switch2-restart.py"))
WAVES = "10"

def run(command, cwd=None, env=None):
    """Run a command in this terminal; Ctrl-C is left to the command, then we return to the menu."""
    print("\n$ " + " ".join(command), flush=True)
    process = subprocess.Popen(command, cwd=cwd, env=env)
    while True:
        try:
            return process.wait()
        except KeyboardInterrupt:
            pass            # the command got the same Ctrl-C; wait for it to finish cleaning up


def kaihen():
    env = dict(os.environ, NS2_WAVE_ATTEMPTS=WAVES)
    env.setdefault("NS2_TRIGGER_SHIFT_NS", "-200000")
    code = run(["node", "engine/hen.cjs", IP, "--dir", KAIHEN_DIR], cwd=KAIHEN_REPO, env=env)
    print("\nkaiHEN exited with code %d." % code)


def save_and_restart():
    code = run([sys.executable, os.path.join(SAVE_TOOLS, "restore_save.py"),
                os.path.join(SAVE_TOOLS, "trigger-recreate"), IP])
    if code != 0:
        print("\nThe trigger save was NOT installed (exit %d), so the console was not restarted.\n"
              "Restarting now would lose the loader. Check Civ VII shows 'Awaiting payload' and try again." % code)
        return
    code = run([sys.executable, RESTART, IP, "--yes"])
    if code == 0:
        print("\nRestarting. Start Civ VII, open Load Game, then press Enter here for the next attempt.")
    else:
        print("\nThe trigger save is installed, but the restart did not go through (exit %d). Restart by hand." % code)


def main():
    while True:
        print("\n=== kaiHEN console (%s) ===" % IP)
        print("  Enter  run kaiHEN, %s waves" % WAVES)
        print("  1      install trigger save, then restart the console")
        print("  q      quit")
        try:
            choice = input("> ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print()
            return 0
        if choice == "":
            kaihen()
        elif choice == "1":
            save_and_restart()
        elif choice in ("q", "quit", "exit"):
            return 0
        else:
            print("Not an option.")


if __name__ == "__main__":
    sys.exit(main())

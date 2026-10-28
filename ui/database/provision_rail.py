#!/usr/bin/env python3
"""
Register a rail (or rotate its secret) for the cloud relay.

    python database/provision_rail.py rail-1 "Clinic A rail"

Prints the rail's secret ONCE. Put it in the firmware's include/secrets.h
(RAIL_ID / RAIL_SECRET). Only a hash is stored, so a lost secret can't be read
back, only replaced by running this again (which invalidates the old one).

Without POSTGRES_URL it writes to the local SQLite database; to provision the
production rail, pull the environment first (vercel env pull .env.local) and
load POSTGRES_URL before running. Never commit the secret.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import db_manager  # noqa: E402
import rail_service  # noqa: E402


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    rail_id = sys.argv[1]
    name = sys.argv[2] if len(sys.argv) > 2 else ""
    target = "PRODUCTION (Postgres)" if db_manager.IS_POSTGRES else "local SQLite"
    secret = rail_service.provision_rail(rail_id, name)
    print(f"Rail '{rail_id}' registered in {target}.")
    print("")
    print(f'  #define RAIL_ID     "{rail_id}"')
    print(f'  #define RAIL_SECRET "{secret}"')
    print("")
    print("Copy these into firmware/esp8266-stepper/include/secrets.h now. The secret is not shown again.")


if __name__ == "__main__":
    main()

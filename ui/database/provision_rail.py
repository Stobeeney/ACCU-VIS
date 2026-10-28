#!/usr/bin/env python3
"""
Register a rail (or rotate its secret) for the cloud relay.

  Local database (bench tests):
      python database/provision_rail.py rail-1 "Clinic A rail"

  Production database WITHOUT sharing any database password:
      python database/provision_rail.py rail-1 "Clinic A rail" --sql
  This touches no database. It prints the rail's secret (you keep it) and a SQL snippet that the
  owner of the Supabase project pastes into the SQL editor. Only a hash goes into the database.

The secret is shown ONCE. Put it in the firmware's include/secrets.h (RAIL_ID / RAIL_SECRET).
Only a hash is stored, so a lost secret can't be read back, only replaced by running this again
(which invalidates the old one). Never commit the secret.

To write directly to production instead, load POSTGRES_URL first (vercel env pull .env.local).
"""
import hashlib
import os
import re
import secrets
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

RAIL_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def sql_text(value):
    return "'" + value.replace("'", "''") + "'"


def print_sql(rail_id, name):
    secret = secrets.token_urlsafe(24)
    secret_hash = hashlib.sha256(secret.encode("utf-8")).hexdigest()
    created = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    print("Nothing was written to any database. Two things to do:")
    print("")
    print("1) Put this in firmware/esp8266-stepper/include/secrets.h (keep it private):")
    print("")
    print(f'  #define RAIL_ID     "{rail_id}"')
    print(f'  #define RAIL_SECRET "{secret}"')
    print("")
    print("2) Ask the owner of the Supabase project to run this in the SQL editor (it contains only a hash):")
    print("")
    print("  INSERT INTO rails (rail_id, name, secret_hash, created_at)")
    print(f"  VALUES ({sql_text(rail_id)}, {sql_text(name)}, '{secret_hash}', '{created}')")
    print("  ON CONFLICT (rail_id) DO UPDATE SET secret_hash = EXCLUDED.secret_hash, name = EXCLUDED.name;")
    print(f"  INSERT INTO rail_state (rail_id, stop_latched) VALUES ({sql_text(rail_id)}, 0) ON CONFLICT (rail_id) DO NOTHING;")
    print("")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a for a in sys.argv[1:] if a.startswith("--")}
    if not args:
        print(__doc__)
        sys.exit(1)
    rail_id = args[0]
    name = args[1] if len(args) > 1 else ""
    if not RAIL_ID_PATTERN.match(rail_id):
        sys.exit("rail_id may only contain letters, digits, '.', '_' and '-' (max 64 characters).")

    if "--sql" in flags:
        print_sql(rail_id, name)
        return

    import db_manager  # noqa: E402  (imported late: --sql must not touch any database)
    import rail_service  # noqa: E402

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

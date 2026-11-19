"""Drops and recreates the development database with the dev seed. Refuses unless DEV_AUTH=true."""
from ..config import config
from ..migrate import migrate, reset_database

if __name__ == "__main__":
    if not config.DEV_AUTH:
        raise SystemExit("refusing to reset: DEV_AUTH is not true (is this production?)")
    reset_database()
    print(migrate(seed_dev=True))

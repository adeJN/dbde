/** Diagnose server upgrade failures without hiding the original database error. */
export function databaseUpgradeIssue(error: string) {
  if (
    !/column count of mysql\.\w+ is wrong/i.test(error) ||
    !/MariaDB|mysql[_-]upgrade|mariadb-upgrade/i.test(error)
  )
    return undefined;
  const versions = error.match(
    /Created with MariaDB (\d+), now running (\d+)/i,
  );
  const version = (encoded: string) => {
    const value = Number(encoded);
    return `${Math.floor(value / 10000)}.${Math.floor(value / 100) % 100}.${value % 100}`;
  };
  return {
    title: "MariaDB system tables need an upgrade",
    description: versions
      ? `The system tables were created for MariaDB ${version(versions[1])}, but the server is running ${version(versions[2])}. Stored routine metadata cannot be loaded until the server upgrade is completed.`
      : "A MariaDB system table does not match the running server version. Object metadata cannot be loaded until the server upgrade is completed.",
    recovery:
      "Back up the server, then have its administrator run mariadb-upgrade (mysql_upgrade on older installations) using the tool bundled with that server. Reconnect and retry after the upgrade. DBde does not modify system tables automatically.",
  };
}

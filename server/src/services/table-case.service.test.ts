import { describe, it, expect } from 'vitest';
import { restoreCaseWarning, backupCaseWarning, type TableCaseInfo } from './table-case.service';

const info = (lowerCaseTableNames: number, capitalized: string[] = []): TableCaseInfo => ({ lowerCaseTableNames, capitalized, capitalizedCount: capitalized.length });

describe('table name case warnings', () => {
  it('warns when a server that lowercases names receives tables with capitals', () => {
    const w = restoreCaseWarning(info(0, ['AppSettings', 'UserReferral', 'Zed', 'Four']), info(1));
    expect(w).toMatch(/AppSettings, UserReferral, Zed and 1 more will be created in lowercase/);
  });

  it('warns when a lowercase backup goes to a server that keeps case', () => {
    expect(restoreCaseWarning(info(1), info(0))).toMatch(/all its table names are lowercase/);
  });

  it('stays quiet when nothing changes', () => {
    expect(restoreCaseWarning(info(0, ['AppSettings']), info(0))).toBeNull(); // case kept
    expect(restoreCaseWarning(info(0, []), info(1))).toBeNull(); // nothing with capitals
    expect(restoreCaseWarning(info(1), info(1))).toBeNull(); // lowercase to lowercase
    expect(restoreCaseWarning(null, info(0))).toBeNull(); // source unknown, target keeps case
    expect(restoreCaseWarning(info(0, ['A']), info(2))).toBeNull(); // 2 keeps names as written
  });

  it('warns about backups of a server that lowercases names', () => {
    expect(backupCaseWarning(info(1))).toMatch(/backups of it have lowercase table names/);
    expect(backupCaseWarning(info(0, ['AppSettings']))).toBeNull();
  });
});

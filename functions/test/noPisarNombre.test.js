/**
 * Una autorización manual con DNI ya cargado no renombra people ni personalMaster.
 * La nómina (alta y importación masiva) sigue siendo la fuente de verdad del nombre.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  setupHarness,
  startRouters,
  defaultRoleDocs,
  signTestToken,
  TEST_JWT_SECRET
} = require('./helpers/routeHarness');

const NAME_FIELDS = ['name', 'nombre', 'nameLower', 'nameKey', 'nameTokens'];

const person = (extra) => ({
  active: true,
  origen: 'nomina',
  ...extra
});

describe('no pisar el nombre de una persona ya cargada', () => {
  let mem;
  let srv;
  let nomina;

  const token = () => signTestToken({ id: 'admin', role: 'admin' });

  const postAuth = (body) => srv.request('POST', '/api/admin/authorizations', {
    token: token(),
    body: { type: 'citacion', startDate: '2026-10-09', ...body }
  });

  const docsOf = (collection) => {
    const ids = ['p1', 'm1', 'pAccent', 'pEmpty', 'mEmpty', 'pSave', 'mSave', 'pNom', 'mNom'];
    for (let i = 1; i <= 40; i += 1) ids.push(`auto-${i}`);
    return ids
      .map((id) => {
        const data = mem.getDoc(collection, id);
        return data ? { id, ...data } : null;
      })
      .filter(Boolean);
  };

  before(async () => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    mem = setupHarness({
      initial: {
        roles: defaultRoleDocs(),
        users: {
          admin: { username: 'admin', role: 'admin', active: true, passwordVersion: 1, permissions: [] }
        },
        people: {
          p1: person({
            name: 'GARCIA Maria',
            nombre: 'GARCIA Maria',
            nameLower: 'garcia maria',
            nameKey: 'garcia maria',
            nameTokens: 'garcia maria',
            dni: '30111222',
            dniNormalized: '30111222',
            idNumber: '30111222',
            idNumberNormalized: '30111222',
            legajo: '100',
            legajoNormalized: '100'
          }),
          pAccent: person({
            name: 'García María',
            nombre: 'García María',
            nameLower: 'garcia maria',
            nameKey: 'garcia maria',
            nameTokens: 'garcia maria',
            dni: '30111223',
            dniNormalized: '30111223',
            idNumber: '30111223',
            idNumberNormalized: '30111223',
            legajo: '101',
            legajoNormalized: '101'
          }),
          pEmpty: person({
            name: '',
            nombre: '',
            dni: '20111000',
            dniNormalized: '20111000',
            idNumber: '20111000',
            idNumberNormalized: '20111000',
            legajo: '8',
            legajoNormalized: '8'
          }),
          pSave: person({
            name: 'LOPEZ Ana',
            nombre: 'LOPEZ Ana',
            nameLower: 'lopez ana',
            nameKey: 'ana lopez',
            nameTokens: 'ana lopez',
            dni: '30999000',
            dniNormalized: '30999000',
            idNumber: '30999000',
            idNumberNormalized: '30999000',
            legajo: '77',
            legajoNormalized: '77'
          }),
          pNom: person({
            name: 'SOSA Franco',
            nombre: 'SOSA Franco',
            nameLower: 'sosa franco',
            nameKey: 'franco sosa',
            nameTokens: 'franco sosa',
            dni: '23796878',
            dniNormalized: '23796878',
            idNumber: '23796878',
            idNumberNormalized: '23796878',
            legajo: '26',
            legajoNormalized: '26'
          })
        },
        personalMaster: {
          m1: {
            name: 'GARCIA Maria',
            nombre: 'GARCIA Maria',
            nameLower: 'garcia maria',
            nameKey: 'garcia maria',
            nameTokens: 'garcia maria',
            legajo: '100',
            legajoNormalized: '100',
            idNumber: '30111222',
            idNumberNormalized: '30111222',
            personId: 'p1',
            source: 'nomina'
          },
          mEmpty: {
            name: '',
            nombre: '',
            nameLower: '',
            legajo: '8',
            legajoNormalized: '8',
            idNumber: '20111000',
            idNumberNormalized: '20111000',
            personId: 'pEmpty',
            source: 'nomina'
          },
          mSave: {
            name: 'LOPEZ Ana',
            nombre: 'LOPEZ Ana',
            nameLower: 'lopez ana',
            nameKey: 'ana lopez',
            nameTokens: 'ana lopez',
            legajo: '77',
            legajoNormalized: '77',
            idNumber: '30999000',
            idNumberNormalized: '30999000',
            personId: 'pSave',
            source: 'nomina'
          },
          mNom: {
            name: 'SOSA Franco',
            nombre: 'SOSA Franco',
            nameLower: 'sosa franco',
            nameKey: 'franco sosa',
            nameTokens: 'franco sosa',
            legajo: '26',
            legajoNormalized: '26',
            idNumber: '23796878',
            idNumberNormalized: '23796878',
            personId: 'pNom',
            source: 'nomina'
          }
        }
      }
    });
    srv = await startRouters(['routes/authorizations.js']);
    nomina = require('../nominaImport');
  });

  after(async () => { await srv.close(); });

  it('autorización manual con DNI existente y nombre distinto conserva el nombre y avisa', async () => {
    const beforePeople = { ...mem.getDoc('people', 'p1') };
    const beforeMaster = { ...mem.getDoc('personalMaster', 'm1') };

    const res = await postAuth({
      name: 'Garcia Mariano',
      idNumber: '30111222',
      company: 'BACAR',
      destination: 'Planta'
    });

    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.warning, 'El DNI pertenece a GARCIA Maria; se mantuvo ese nombre.');
    assert.equal(res.body.authorization.name, 'GARCIA Maria');
    assert.equal(res.body.authorization.nameTyped, 'Garcia Mariano');
    assert.equal(res.body.authorization.personId, 'p1');

    const stored = mem.getDoc('authorizations', res.body.authorization.id);
    assert.equal(stored.name, 'GARCIA Maria');
    assert.equal(stored.nameTyped, 'Garcia Mariano');
    assert.equal(stored.nameKey, 'garcia maria');

    const people = mem.getDoc('people', 'p1');
    const master = mem.getDoc('personalMaster', 'm1');
    NAME_FIELDS.forEach((field) => {
      assert.equal(people[field], beforePeople[field], `people.${field}`);
      assert.equal(master[field], beforeMaster[field], `personalMaster.${field}`);
    });
    assert.equal(
      docsOf('people').some((doc) => doc.name === 'Garcia Mariano' || doc.nombre === 'Garcia Mariano'),
      false
    );
    assert.equal(
      docsOf('personalMaster').some((doc) => doc.name === 'Garcia Mariano' || doc.nombre === 'Garcia Mariano'),
      false
    );
  });

  it('el mismo nombre normalizado no avisa y no renombra', async () => {
    const res = await postAuth({
      name: 'garcia maria',
      idNumber: '30.111.223'
    });

    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.warning, undefined);
    assert.equal(res.body.authorization.nameTyped, undefined);
    assert.equal(mem.getDoc('people', 'pAccent').name, 'García María');
    assert.equal(mem.getDoc('people', 'pAccent').nombre, 'García María');
  });

  it('persona nueva se crea con el nombre tipeado', async () => {
    const res = await postAuth({
      name: 'Quinteros Beatriz',
      idNumber: '40999888',
      company: 'Visitas'
    });

    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.warning, undefined);
    assert.equal(res.body.authorization.nameTyped, undefined);
    assert.equal(res.body.authorization.name, 'Quinteros Beatriz');

    assert.notEqual(res.body.authorization.personId, 'pSave');
    const created = mem.getDoc('people', res.body.authorization.personId);
    assert.ok(created, 'falta la persona');
    assert.equal(created.name, 'Quinteros Beatriz');
    assert.equal(created.nombre, 'Quinteros Beatriz');
    assert.equal(created.dniNormalized, '40999888');

    const master = docsOf('personalMaster').find((doc) => doc.idNumberNormalized === '40999888');
    assert.ok(master, 'falta personalMaster');
    assert.equal(master.name, 'Quinteros Beatriz');
  });

  it('persona existente sin nombre toma el nombre tipeado', async () => {
    const res = await postAuth({
      name: 'Nuevo Nombre',
      idNumber: '20111000'
    });

    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.warning, undefined);
    assert.equal(res.body.authorization.personId, 'pEmpty');
    assert.equal(res.body.authorization.name, 'Nuevo Nombre');
    assert.equal(mem.getDoc('people', 'pEmpty').name, 'Nuevo Nombre');
    assert.equal(mem.getDoc('people', 'pEmpty').nombre, 'Nuevo Nombre');
    assert.equal(mem.getDoc('personalMaster', 'mEmpty').name, 'Nuevo Nombre');
  });

  it('el alta de nómina actualiza el nombre (updateName)', async () => {
    await nomina.saveNominaEmployee({
      name: 'LOPEZ Ana Maria',
      idNumber: '30999000',
      legajo: '77',
      area: 'Sistemas',
      centroCosto: 'BACAR SA - Sistemas',
      authorizationPolicy: 'permanent'
    });

    const people = mem.getDoc('people', 'pSave');
    const master = mem.getDoc('personalMaster', 'mSave');
    assert.equal(people.name, 'LOPEZ Ana Maria');
    assert.equal(people.nombre, 'LOPEZ Ana Maria');
    assert.equal(master.name, 'LOPEZ Ana Maria');
  });

  it('la importación masiva de nómina actualiza el nombre', async () => {
    const job = await nomina.createNominaImportJob([{
      Legajo: '26',
      Apellido: 'SOSA',
      Nombre: 'Franco Ariel',
      DNI: '23796878',
      Áreas: 'Sistemas',
      Puestos: 'Técnico',
      'Centros de Costo': 'BACAR SA - Sistemas',
      Estado: 'Activo'
    }], { importedBy: 'test' });

    const step = await nomina.processNominaImportStep(job.jobId);
    assert.equal(step.imported, 1, JSON.stringify(step.errors));

    const people = mem.getDoc('people', 'pNom');
    const master = mem.getDoc('personalMaster', 'mNom');
    assert.equal(people.name, 'SOSA Franco Ariel');
    assert.equal(people.nombre, 'SOSA Franco Ariel');
    assert.equal(master.name, 'SOSA Franco Ariel');
  });
});

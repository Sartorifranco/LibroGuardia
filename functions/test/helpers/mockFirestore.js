const createQueryResult = (docs = []) => ({
  empty: docs.length === 0,
  docs: docs.map((item) => ({
    id: item.id,
    ref: item.ref || {
      update: item.update || (async () => {})
    },
    data: () => {
      const { id, ref, update, ...data } = item;
      return data;
    }
  }))
});

const createMockFirestore = ({
  people = [],
  authorizations = [],
  entries = [],
  onEntryAdd = null,
  onPeopleUpdate = null
} = {}) => {
  const entryWrites = [];
  const authQueries = [];
  const peopleUpdates = [];

  const matchDoc = (doc, filters) => filters.every((filter) => {
    const value = doc[filter.field];
    if (filter.op === '==') return value === filter.value;
    if (filter.op === 'in') return filter.value.includes(value);
    if (filter.op === '<=') return value <= filter.value;
    if (filter.op === '>=') return value >= filter.value;
    return false;
  });

  const queryCollection = (collectionName, filters = []) => {
    const source = collectionName === 'people'
      ? people
      : collectionName === 'authorizations'
        ? authorizations
        : [];

    const limitFilter = filters.find((filter) => Object.prototype.hasOwnProperty.call(filter, 'limit'));
    const activeFilters = filters.filter((filter) => !Object.prototype.hasOwnProperty.call(filter, 'limit'));

    if (collectionName === 'authorizations') {
      authQueries.push(activeFilters);
    }

    const docs = source.filter((doc) => matchDoc(doc, activeFilters));
    const limitedDocs = limitFilter ? docs.slice(0, limitFilter.limit) : docs;
    return createQueryResult(limitedDocs);
  };

  const makeQuery = (collectionName, filters = []) => ({
    where(field, op, value) {
      return makeQuery(collectionName, [...filters, { field, op, value }]);
    },
    limit(count) {
      return makeQuery(collectionName, [...filters, { limit: count }]);
    },
    async get() {
      return queryCollection(collectionName, filters);
    }
  });

  const db = {
    collection(name) {
      if (name === 'entries') {
        return {
          add: async (payload) => {
            entryWrites.push(payload);
            if (onEntryAdd) onEntryAdd(payload);
            return { id: `entry-${entryWrites.length}` };
          },
          doc(id) {
            return {
              update: async (payload) => {
                entryWrites.push({ id, ...payload });
              }
            };
          }
        };
      }

      if (name === 'settings') {
        return {
          doc() {
            return {
              async get() {
                return { exists: false, data: () => ({}) };
              }
            };
          }
        };
      }

      return makeQuery(name);
    }
  };

  const patchPeopleUpdate = (personId, payload) => {
    peopleUpdates.push({ personId, payload });
    if (onPeopleUpdate) onPeopleUpdate(personId, payload);
    const person = people.find((item) => item.id === personId);
    if (person) Object.assign(person, payload);
  };

  people.forEach((person) => {
    if (!person.ref) {
      person.ref = {
        update: async (payload) => patchPeopleUpdate(person.id, payload)
      };
    }
  });

  return {
    db,
    FieldValue: {
      serverTimestamp: () => 'SERVER_TIMESTAMP'
    },
    Timestamp: {},
    entryWrites,
    authQueries,
    peopleUpdates
  };
};

const installFirestoreMock = (mockExports) => {
  const firestorePath = require.resolve('../../firestore');
  const accessControlPath = require.resolve('../../accessControl');
  const authorizationsPath = require.resolve('../../authorizations');

  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: mockExports
  };

  delete require.cache[accessControlPath];
  delete require.cache[authorizationsPath];

  return require('../../accessControl');
};

module.exports = {
  createQueryResult,
  createMockFirestore,
  installFirestoreMock
};

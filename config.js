const DOMAIN = 'https://ws-acc.vlpar.be/';
const VP_API_CLIENT_ID = 'H8g9HsvY-vTux9D4T2_J4Q..';
const VP_API_CLIENT_SECRET = 'hs0rIeglv-2wutYjG8tSxA..';

const DOCUMENT_TYPES = {
  BESLISSINGSFICHE: 'http://themis.vlaanderen.be/id/concept/document-type/e807feec-1958-46cf-a558-3379b5add49e',
  DECREET: 'https://data.vlaanderen.be/id/concept/AardWetgeving/Decreet',
  MEMORIE: 'http://themis.vlaanderen.be/id/concept/document-type/f036e016-268e-4611-8fee-77d2047b51d8',
  NOTA: 'http://themis.vlaanderen.be/id/concept/document-type/f2b0f655-8ed7-4f61-8f2b-ca813de7a6ed',
  ADVIES: 'http://themis.vlaanderen.be/id/concept/document-type/fb931eff-38f2-4743-802b-4240c35b8b0c',
};

const SUBCASE_TYPES = {
  DEFINITIEVE_GOEDKEURING: 'http://themis.vlaanderen.be/id/concept/procedurestap-type/6f7d1086-7c02-4a80-8c60-5690894f70fc',
  BEKRACHTIGING_VLAAMSE_REGERING: 'http://themis.vlaanderen.be/id/concept/procedurestap-type/bdba2bbc-7af6-490b-98a8-433955cfe869',
};

const DECISION_RESULT_CODES = {
  GOEDGEKEURD: 'http://themis.vlaanderen.be/id/concept/beslissing-resultaatcodes/56312c4b-9d2a-4735-b0b1-2ff14bb524fd',
};

const ACCESS_LEVELS = {
  INTERN_OVERHEID: 'http://themis.vlaanderen.be/id/concept/toegangsniveau/634f438e-0d62-4ae4-923a-b63460f6bc46',
  PUBLIEK: 'http://themis.vlaanderen.be/id/concept/toegangsniveau/c3de9c70-391e-4031-a85e-4b03433d6266',
};

export {
  DOMAIN,
  VP_API_CLIENT_ID,
  VP_API_CLIENT_SECRET,
  DOCUMENT_TYPES,
  SUBCASE_TYPES,
  DECISION_RESULT_CODES,
  ACCESS_LEVELS,
};

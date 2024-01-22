function isTruthy(value) {
  return [true, 'true', 1, '1', 'yes', 'Y', 'on'].includes(value);
}

const DOMAIN = process.env.VP_API_DOMAIN;
const VP_API_CLIENT_ID = process.env.VP_API_CLIENT_ID;
const VP_API_CLIENT_SECRET = process.env.VP_API_CLIENT_SECRET;
const VP_GRAPH_URI = "http://mu.semte.ch/graphs/system/parliament";
const KANSELARIJ_GRAPH_URI = "http://mu.semte.ch/graphs/organizations/kanselarij";
const PUBLIC_GRAPH_URI = "http://mu.semte.ch/graphs/public";

if ([DOMAIN, VP_API_CLIENT_ID, VP_API_CLIENT_SECRET].some((envVar) => !envVar)) {
  console.warn(
    'Required environment variables were not set. Execution cannot proceed, logging variables and exiting.'
  );
  console.warn(`VP_API_DOMAIN: "${DOMAIN}"`);
  console.warn(`VP_API_CLIENT_ID: "${VP_API_CLIENT_ID}"`);
  console.warn(`VP_API_CLIENT_SECRET: "${VP_API_CLIENT_SECRET}"`);
  process.exit(1);
}

const ENABLE_DEBUG_FILE_WRITING = isTruthy(process.env.ENABLE_DEBUG_FILE_WRITING);
const ENABLE_SENDING_TO_VP_API = isTruthy(process.env.ENABLE_SENDING_TO_VP_API);
const ENABLE_ALWAYS_CREATE_PARLIAMENT_FLOW = isTruthy(process.env.ENABLE_ALWAYS_CREATE_PARLIAMENT_FLOW);

const DOCUMENT_TYPES = {
  BESLISSINGSFICHE: 'http://themis.vlaanderen.be/id/concept/document-type/e807feec-1958-46cf-a558-3379b5add49e',
  DECREET: 'https://data.vlaanderen.be/id/concept/AardWetgeving/Decreet',
  MEMORIE: 'http://themis.vlaanderen.be/id/concept/document-type/f036e016-268e-4611-8fee-77d2047b51d8',
  NOTA: 'http://themis.vlaanderen.be/id/concept/document-type/f2b0f655-8ed7-4f61-8f2b-ca813de7a6ed',
  ADVIES: 'http://themis.vlaanderen.be/id/concept/document-type/fb931eff-38f2-4743-802b-4240c35b8b0c',
};

const SUBCASE_TYPES = {
  DEFINITIEVE_GOEDKEURING: 'http://themis.vlaanderen.be/id/concept/procedurestap-type/6f7d1086-7c02-4a80-8c60-5690894f70fc',
  PRINCIPIELE_GOEDKEURING: 'http://themis.vlaanderen.be/id/concept/procedurestap-type/7b90b3a6-2787-4b41-8a1d-886fc5abbb33',
  BEKRACHTIGING_VLAAMSE_REGERING: 'http://themis.vlaanderen.be/id/concept/procedurestap-type/bdba2bbc-7af6-490b-98a8-433955cfe869',
};

const DECISION_RESULT_CODES = {
  GOEDGEKEURD: 'http://themis.vlaanderen.be/id/concept/beslissing-resultaatcodes/56312c4b-9d2a-4735-b0b1-2ff14bb524fd',
};

const ACCESS_LEVELS = {
  INTERN_OVERHEID: 'http://themis.vlaanderen.be/id/concept/toegangsniveau/634f438e-0d62-4ae4-923a-b63460f6bc46',
  PUBLIEK: 'http://themis.vlaanderen.be/id/concept/toegangsniveau/c3de9c70-391e-4031-a85e-4b03433d6266',
};

const PARLIAMENT_FLOW_STATUSES = {
  INCOMPLETE: 'http://themis.vlaanderen.be/id/parlementaireaangelegenheid-status/d30fdd4d-ba47-437d-b72e-4bff02e8c3fb',
  COMPLETE: 'http://themis.vlaanderen.be/id/parlementaireaangelegenheid-status/018fb31c-44ad-4bf5-b01b-76de2d48abf4',
  BEING_HANDLED: 'http://themis.vlaanderen.be/id/parlementaireaangelegenheid-status/3905d9a1-c841-42fc-8a89-3b7d4ad61b4b',
  VP_ERROR: 'http://themis.vlaanderen.be/id/parlementaireaangelegenheid-status/3d03c20e-0170-43f5-840e-a541d1fd22bd',
};

/** These requirements are used to check for the existence of a documentType
 * on the current agendaitem, and then loop over the pieces & subcases to see
 * which pieces and files are required.
 */
const DOCUMENT_REQUIREMENTS = [
  {
    documentType: DOCUMENT_TYPES.DECREET,
    requirements: [
      {
        subcaseType: SUBCASE_TYPES.DEFINITIEVE_GOEDKEURING,
        requiredPieces: [
          {
            pieceType: DOCUMENT_TYPES.BESLISSINGSFICHE,
            fileTypes: ['isPdf', 'isSigned']
          },
          {
            pieceType: DOCUMENT_TYPES.DECREET,
            fileTypes: ['isWord', 'isPdf', 'isSigned']
          },
          {
            pieceType: DOCUMENT_TYPES.MEMORIE,
            fileTypes: ['isWord', 'isPdf', 'isSigned']
          },
          {
            pieceType: DOCUMENT_TYPES.NOTA,
            fileTypes: ['isPdf']
          },
          {
            pieceType: DOCUMENT_TYPES.ADVIES,
            fileTypes: ['isPdf']
          }
        ]
      },
      {
        subcaseType: SUBCASE_TYPES.PRINCIPIELE_GOEDKEURING,
        requiredPieces: [
          {
            pieceType: DOCUMENT_TYPES.BESLISSINGSFICHE,
            fileTypes: ['isPdf', 'isSigned']
          },
          {
            pieceType: DOCUMENT_TYPES.DECREET,
            fileTypes: ['isWord', 'isPdf']
          },
          {
            pieceType: DOCUMENT_TYPES.MEMORIE,
            fileTypes: ['isWord', 'isPdf']
          },
          {
            pieceType: DOCUMENT_TYPES.NOTA,
            fileTypes: ['isPdf']
          },
          {
            pieceType: DOCUMENT_TYPES.ADVIES,
            fileTypes: ['isPdf']
          }
        ]
      }
    ]
  }
];

const VP_PARLIAMENT_FLOW_STATUSES = {
  BEING_HANDLED: "te behandelen in commissie"
}

const VP_ERROR_EXPIRE_TIME = 60;

const JOB = {
  STATUSES: {
    SCHEDULED: "http://redpencil.data.gift/id/concept/JobStatus/scheduled",
    BUSY: "http://redpencil.data.gift/id/concept/JobStatus/busy",
    SUCCESS: "http://redpencil.data.gift/id/concept/JobStatus/success",
    FAILED: "http://redpencil.data.gift/id/concept/JobStatus/failed",
  },
  GRAPH: VP_GRAPH_URI,
  RESOURCE_BASE_URI:
    "http://mu.semte.ch/services/vlaams-parlement-sync/send-to-parliament-job/",
  CONTEXT_RESOURCE_BASE_URI:
    "http://mu.semte.ch/services/vlaams-parlement-sync/send-to-parliament-job-context/",
};

export {
  DOMAIN,
  VP_API_CLIENT_ID,
  VP_API_CLIENT_SECRET,
  DOCUMENT_TYPES,
  SUBCASE_TYPES,
  DECISION_RESULT_CODES,
  ACCESS_LEVELS,
  PARLIAMENT_FLOW_STATUSES,
  VP_PARLIAMENT_FLOW_STATUSES,
  ENABLE_DEBUG_FILE_WRITING,
  ENABLE_SENDING_TO_VP_API,
  ENABLE_ALWAYS_CREATE_PARLIAMENT_FLOW,
  DOCUMENT_REQUIREMENTS,
  VP_GRAPH_URI,
  VP_ERROR_EXPIRE_TIME,
  KANSELARIJ_GRAPH_URI,
  PUBLIC_GRAPH_URI,
  JOB,
};

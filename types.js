/**
 * @typedef {Object} GovernmentField
 * @property {string} uri
 * @property {string} label
 */

/**
 * @typedef {Object} DecisionmakingFlow
 * @property {string} uri
 * @property {string} name
 * @property {string} altName
 * @property {string} case
 * @property {GovernmentField[]} governmentFields
 */

/**
 * @typedef {Object} Concept
 * @property {string} uri
 * @property {string} label
 */

/**
 * @typedef {Object} File
 * @property {string} uri
 * @property {string} format
 * @property {string} shareUri
 */

/**
 * @typedef {Object} Piece
 * @property {string} id
 * @property {string} uri
 * @property {string} name
 * @property {Date} created
 * @property {Concept} type
 * @property {File[]} files
 */

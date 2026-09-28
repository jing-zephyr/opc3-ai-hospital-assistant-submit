const path = require('path');
const serverless = require('serverless-http');
const app = require(path.join(__dirname, '../../src/server.js'));

exports.handler = serverless(app);

const { installExpressExtension } = require('../lib/tools-extension');

installExpressExtension();

const express = require('express');

if (typeof express !== 'function') throw new Error('Express wrapper deixou de ser uma função.');
if (typeof express.json !== 'function') throw new Error('express.json não está disponível após o bootstrap.');
if (typeof express.static !== 'function') throw new Error('express.static não está disponível após o bootstrap.');
if (typeof express.Router !== 'function') throw new Error('express.Router não está disponível após o bootstrap.');

const app = express();
if (!app || typeof app.use !== 'function' || typeof app.listen !== 'function') {
  throw new Error('A extensão não conseguiu criar uma aplicação Express válida.');
}

console.log('Tools bootstrap smoke check: OK');

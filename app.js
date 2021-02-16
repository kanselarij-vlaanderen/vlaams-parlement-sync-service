import { app, errorHandler } from 'mu';
import fetch from 'node-fetch';
import { DOMAIN, VP_API_CLIENT_ID, VP_API_CLIENT_SECRET } from './config';
import bodyParser from 'body-parser';
import { readFileSync } from 'fs';
import VP from './lib/vp';

app.use(bodyParser.json());

app.post('/', async function (req, res, next) {
  console.log("Sending dossier...");

  const content = await readFileSync('app/data/kaleidos-vp.json');

  const response = await VP.sendDossier(content);

  if (response.ok) {
   return res.status(200).end(); 
  } else {
    return res.status(202).end();
  }
});


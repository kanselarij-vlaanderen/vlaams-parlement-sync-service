import { DOMAIN, VP_API_CLIENT_ID, VP_API_CLIENT_SECRET } from '../config';
import fetch from 'node-fetch';
import { encode } from "base-64";

class VP {
  constructor() {
    this.expireTime = 0;
  }

  async initialize() {
    this.token = await this.getAccessToken()
  }

  async getAccessToken() {
    if (Date.now() > this.expireTime) {
      const newToken = await this.refreshAccessToken();
      this.token = newToken.access_token;
      this.expireTime = Date.now() + parseInt(newToken.expires_in) * 1000;
    } 

    return this.token;
  }

  async refreshAccessToken() {
    console.log("Requesting new access token...");
    const oauth2 = encode(VP_API_CLIENT_ID + ":" + VP_API_CLIENT_SECRET);
    const response = await fetch(`${DOMAIN}api/kaleidos/oauth/token`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + oauth2,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials'
    });

    console.log(response);
    if (response.ok) {
      console.log(`Access token successfully retrieved.`);
      return await response.json();
    } else {
      console.log(`Failed to retrieve access token for VP: ${response.status} ${response.statusText}`);
    }
  }

  async sendDossier(dossier) {
    const accessToken = await this.getAccessToken();
    console.debug('accessToken', accessToken);

    const response = await fetch(`${DOMAIN}api/kaleidos/v1/document`, {
      method: 'POST',
      body: JSON.stringify(dossier),
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });
    if (response.ok) {
      console.log(`Dossier successfully sent.`, await response.json());
    } else {
      console.log(`Error sending dossier: ${response.status} ${response.statusText}`);
      console.log(response);
      const out = await response.text();
      console.log(out);
      for (const pair of response.headers.entries()) {
        console.log(`${pair[0]}: ${pair[1]}`);
      }
    }

    return response;
  }
  
}

export default new VP();


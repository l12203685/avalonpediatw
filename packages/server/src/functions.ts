import * as functions from 'firebase-functions';
import { app } from './index';

// Export as a Cloud Function
export const api = functions.https.onRequest(app);

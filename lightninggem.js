'use strict';

require('dotenv').config();

const grpc = require('grpc');
const fs = require("fs");
const crypto = require('crypto');
const helmet = require('helmet');

const LND_HOMEDIR = process.env.LND_HOMEDIR;
const LN_GEM_PORT = process.env.LN_GEM_PORT;
const LN_GEM_INTERNAL_PORT = process.env.LN_GEM_INTERNAL_PORT;
const DB_NAME = process.env.DB_NAME;

const lndCert = fs.readFileSync(LND_HOMEDIR + 'tls.cert');
const credentials = grpc.credentials.createSsl(lndCert);
const lnrpcDescriptor = grpc.load("rpc.proto");
const lnrpc = lnrpcDescriptor.lnrpc;
const lightning = new lnrpc.Lightning('127.0.0.1:10009', credentials);

const adminMacaroon = fs.readFileSync(LND_HOMEDIR + 'admin.macaroon');
const meta = new grpc.Metadata();
meta.add('macaroon', adminMacaroon.toString('hex'));

const express = require('express');
const bodyParser = require('body-parser');
const urlencodedParser = bodyParser.urlencoded({
  extended: true
});

const MongoClient = require('mongodb').MongoClient;
const dbUrl = "mongodb://127.0.0.1:27017";

const app = express();
app.use(express.static("public"));
app.use(helmet());
var db;

/**
 * The current gem containing the owner's details
 */
var gem;

/**
 * A map of invoice r_hashes to response objects for clients 
 * listening for when those invoices are settled or terminated
 */
var listeners = {};

const http = require('http');
http.createServer(async (req, res) => {
  //check for timeout on internal requests
  if (gem.owner && gem.date < (new Date().getTime() - 12 * 60 * 60 * 1000)) {
    try {
      gem = await createGem(null, gem, true);
      updateListeners(); //update all clients to indicate gem has expired
      console.log("gem timed out");
    } catch (err) {
      console.error("error on gem reset: " + err);
    };
  }
  res.end();
}).listen(LN_GEM_INTERNAL_PORT);


MongoClient.connect(dbUrl).then((connection) => {
  db = connection.db(DB_NAME);
  return getGem();
}).then((currentGem) => {
  gem = currentGem;
  app.listen(LN_GEM_PORT, () => {
    console.log('App listening on port ' + LN_GEM_PORT);
  });
}).catch((err) => {
  console.error("Error on initialization: " + err);
});


app.get('/gem', (req, res) => {
  res.status(200).json(gem);
});

app.get('/listen/:r_hash', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  listeners[req.params.r_hash] = res;
});

app.post('/invoice', urlencodedParser, (req, res) => {
  if (!req.body.name || req.body.name.length > 50 || req.body.url && req.body.url.length > 50) {
    res.status(400).end(); //this shouldn't happen, there's client-side validation to prevent this
  } else if (gem._id != req.body.gem_id) {
    res.status(400).send("Gem out of sync, try refreshing");
  } else {
    //valid so far, check for and validate payment request
    let responseBody;
    validatePayReq(req.body.pay_req_out).then(() => {
      return addInvoice(req.body.value);
    }).then((response) => {
      const r_hash = response.r_hash.toString('hex');
      responseBody = {
        r_hash: r_hash,
        payment_request: response.payment_request
      };

      const invoice = {
        gemId: req.body.gem_id,
        name: req.body.name,
        url: req.body.url,
        r_hash: response.r_hash.toString('hex'),
        value: req.body.value,
      };
      if (req.body.pay_req_out)
        invoice.pay_req_out = req.body.pay_req_out;

      return db.collection('invoices').insertOne(invoice).then(() => {
        console.log("invoice added: " + JSON.stringify(invoice));
        res.status(200).send(responseBody);
      });
    }).catch((err) => {
      console.error(err);
      res.status(400).send(err);
    });
  }
});

const invoiceSubscription = lightning.subscribeInvoices({}, meta);
invoiceSubscription.on('data', invoiceHandler).on('end', () => {
  console.log("subscribeInvoices ended");
}).on('status', (status) => {
  console.log("subscribeInvoices status: " + status);
}).on('error', (error) => {
  console.error("subscribeInvoices error: " + error);
});

/**
 * Handler for updates on lightning invoices
 * @param data - The data from the lightning invoice subscription
 */
async function invoiceHandler(data) {
  if (data.settled) {
    const r_hash = data.r_hash.toString('hex');
    const invoiceQuery = {
      r_hash: r_hash
    };

    try {
      const invoice = await db.collection('invoices').findOne(invoiceQuery);
      if (invoice) {
        console.log("invoice settled: " + JSON.stringify(invoice));
        const oldGem = gem;
        let newVals = {
          $set: {}
        };
        let reset = false;

        if (gem._id == invoice.gemId) {
          newVals.$set.status = 1;

          if (invoice.pay_req_out) {
            //check for random reset
            const secret = await db.collection('secrets').findOne({
              _id: new Date().toISOString().split('T')[0]
            });
            const hash = crypto.createHash('sha256');
            hash.update(invoice.pay_req_out + secret.secret);
            const buf = hash.digest();
            const firstByteInt = buf.readUIntBE(0, 1);
            console.log('first byte of sha256 hash for ' + invoice.pay_req_out + secret.secret + ' is ' + firstByteInt);
            if (firstByteInt < 8)
              reset = true;
          }
          purchaseGem(invoice, r_hash, reset);
        } else {
          console.log("stale invoice paid");
          sendEvent("stale", r_hash);
          newVals.$set.status = 2;
        }

        //update paid invoice
        db.collection('invoices').updateOne(invoiceQuery, newVals);

        //update previous gem to mark it as bought and pay out previous owner 
        let gemUpdate = {
          $set: {
            bought: true
          }
        };
        if (reset)
          gemUpdate.$set.reset = true;
        if (oldGem.pay_req_out) {
          await sendPayment(oldGem.pay_req_out);
          gemUpdate.$set.paid_out = true;
          console.log("paid " + oldGem.pay_req_out);
        }
        db.collection('gems').updateOne({
          _id: oldGem._id
        }, gemUpdate);
      }
    } catch (err) {
      console.error(err);
    }
  }
}

/**
 * Sends a lightning payment
 * @param pay_req - The payment request to pay
 */
async function sendPayment(pay_req) {
  return new Promise((resolve, reject) => {
    lightning.sendPaymentSync({
      payment_request: pay_req
    }, meta, (err) => {
      if (err)
        reject(err);
      else {
        resolve();
      }
    });
  });
}

/**
 * Adds an invoice to lnd.
 * @param value - The amount in satoshis for the invoice
 */
async function addInvoice(value) {
  return new Promise((resolve, reject) => {
    lightning.addInvoice({
      value: value,
      memo: "Lightning Gem"
    }, meta, (err, response) => {
      if (err) {
        reject("Server Error: " + err);
      } else
        resolve(response);
    });
  });
}

/**
 * Validates an outgoing payment request. 
 * @param pay_req_out - The payment request to validate 
 */
async function validatePayReq(pay_req) {
  return new Promise((resolve, reject) => {
    if (pay_req) {
      lightning.decodePayReq({
        pay_req: pay_req
      }, meta, (err, response) => {
        if (err) {
          reject("Could not decode payment request: " + err);
        } else if (response.num_satoshis != Math.round(gem.price * 1.25)) {
          reject("Invalid payment request value");
        } else if (response.expiry < 43200) {
          reject("Invalid payment request expiry");
        } else {
          resolve();
        }
      });
    } else {
      //valid request without a payment request, this route only valid in testnet
      resolve();
    }
  });
}

/**
 * Fetches the most recent gem from the database.
 * If no gem exists, it creates one.
 * @returns - The most recent gem
 */
async function getGem() {
  return new Promise((resolve, reject) => {
    db.collection('gems').find().sort({
      _id: -1
    }).limit(1).toArray().then((gems) => {
      if (gems[0])
        resolve(gems[0])
      else {
        //this is the very first gem in the series!
        const firstGem = {
          price: 100,
          _id: 1
        };
        db.collection('gems').insertOne(firstGem).then(() => {
          resolve(firstGem);
        });
      }
    }).catch((err) => {
      reject(err);
    });
  });
}

/**
 * Creates a new gem according to the rules of the Lightning
 * Gem, adjusting the price, id, and owner as necessary.
 * @returns - The newly created gem
 */
async function createGem(invoice, oldGem, reset) {
  let newGem = {
    _id: oldGem._id + 1,
    date: new Date().getTime()
  };
  if (reset) {
    newGem.price = 100;
  } else {
    newGem.price = Math.round(oldGem.price * 1.3);
    newGem.owner = invoice.name;
    newGem.url = invoice.url;
    newGem.pay_req_out = invoice.pay_req_out;
  }

  return new Promise((resolve, reject) => {
    db.collection('gems').insertOne(newGem).then(() => {
      resolve(newGem);
    }).catch((err) => {
      reject(err)
    });
  });
}

/**
 * Creates a new gem and updates all listening clients 
 * @param invoice - The invoice database object for the purchase
 * @param r_hash - The r_hash for the invoice that bought the gem
 * @param reset - Whether the gem purchase resulted in a reset
 */
async function purchaseGem(invoice, r_hash, reset) {
  try {
    gem = await createGem(invoice, gem, reset);
    console.log('new gem: ' + JSON.stringify(gem));
    updateListeners(r_hash, reset);
  } catch (err) {
    console.error(err);
  }
}

/**
 * Update and close connections with all listening clients 
 * after gem purchase. 
 * @param r_hash - The r_hash for the invoice that bought the gem
 * @param reset - Whether the gem purchase resulted in a reset
 */
function updateListeners(r_hash, reset) {
  if (reset)
    sendEvent("reset", r_hash);
  else
    sendEvent("settled", r_hash);
  for (const listener_r_hash in listeners) {
    if (listener_r_hash != r_hash) {
      sendEvent("expired", listener_r_hash);
    }
  }
  listeners = {};
}

/**
 * Send an event to and close a connection.
 * @param event - The event type to send
 * @param r_hash - The r_hash corresponding to the listening client
 */
function sendEvent(event, r_hash) {
  const listener = listeners[r_hash];
  if (listener && !listener.finished) {
    try {
      listener.write("data: " + event + "\n\n");
      //listeners[listener_r_hash].set("Connection", "close");
      listener.end();
    } catch (err) {
      console.error(err);
    }
  }
}

module.exports = {
  getGem: getGem,
  //validatePayReq: validatePayReq,
  createGem: createGem,
  //purchaseGem: purchaseGem,
  //sendPayment: sendPayment,
  //addInvoice: addInvoice,
  invoiceHandler: invoiceHandler
}
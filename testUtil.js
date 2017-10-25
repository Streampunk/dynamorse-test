/* Copyright 2017 Streampunk Media Ltd.

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

var test = require('tape');
var WebSocket = require('ws');
var http = require('http');
var Grain = require('./Grain.js');

var properties = {
  redPort: 1880,
  wsPort: 1888
};

function adminApiReq(t, method, path, payload, response, onError, cb) {
  var req = http.request({
    host: 'localhost',
    port : properties.redPort,
    path : path,
    method : method,
    headers : {
      'Content-Type' : 'application/json',
      'Content-Length' : payload.length
    }
  }, (res) => {
    var statusCode = res.statusCode;
    var contentType = res.headers['content-type'];

    t.equal(statusCode, response, 'status code is Success');
    if (!((200 === statusCode) || (204 == statusCode))) {
      onError();
      return;
    }
    if (200 === statusCode)
      t.ok(/^application\/json/.test(contentType), 'content type is application/json');

    res.setEncoding('utf8');
    var rawData = '';
    res.on('data', (chunk) => rawData += chunk);
    res.on('end', () => cb((204 === statusCode)?null:JSON.parse(rawData)));
  }).on('error', (e) => {
    t.fail(`problem with admin API '${method}' request to path '${path}': ${e.message}`);
    onError();
  });

  req.write(payload);
  req.end();
}

function postFlow(t, params, getFlow, wss, onMsg, done) {
  adminApiReq(t, 'POST', '/flow', JSON.stringify(getFlow(params)), 200, done, (res) => {
    t.ok(res.id, 'response has flow id');

    params.count = 0;
    var lastCount = -1;
    var endReceived = false;
    var doneClosedown = false;
    var timeout = params.flowTimeout||1000;

    function deleteFlow(t, flowId, cb) {
      if (params.keepFlow) {
        t.comment('!!! NOT deleting test flow !!!');
        cb();
      } else {
        t.comment('Delete test flow');
        var testFlowDel = `{"id" : "${flowId}"}`;
        adminApiReq(t, 'DELETE', `/flow/${flowId}`, testFlowDel, 204, cb, () => cb()); 
      }
    }

    function checkCompleted(t, flowId, onComplete) {
      if (doneClosedown) {
        onComplete();
      } else if (params.count === lastCount) {
        t.comment('Check for correct closedown');
        t.ok(endReceived, 'end message has been received');
        t.ok(doneClosedown, 'closedown has been completed');
        deleteFlow(t, flowId, () => onComplete());
        doneClosedown = true;
      }
      lastCount = params.count;
    }

    wss.on('connection', ws => {
      t.equal(ws.readyState, WebSocket.OPEN, 'websocket connection is open');
      var id = setInterval(checkCompleted, timeout, t, res.id, () => {
        clearInterval(id);
        done();
      });

      t.comment('Check for expected data from flow');
      ws.on('message', msg => {
        //t.comment(`Message: ${msg}`);
        var msgObj = JSON.parse(msg);
        onMsg(t, params, msgObj, () => {
          endReceived = true;
          deleteFlow(t, res.id, () => {
            doneClosedown = true;
            clearInterval(id);
            done();
          });
        });
        if (msgObj.hasOwnProperty('close'))
          ws.close();
      });
    });
  });
}

function nodeRedTest(description, params, getFlow, onMsg) {
  test(description, (t) => {
    var server = http.createServer((/*req, res*/) => {});
    server.listen(properties.wsPort, 'localhost', () => {
      t.pass(`server is listening on port ${properties.wsPort}`);

      const wss = new WebSocket.Server({ server: server });
      wss.on('error', (error) => t.fail(`websocket server error: '${error}'`));

      postFlow(t, params, getFlow, wss, onMsg, () => {
        wss.close(err => {
          t.notOk(err, err?err:'websocket server closed OK');
          server.close(err => {
            t.notOk(err, err?err:'http server closed OK');
            t.end();
          });
        });
      });
    });
  });
}

var testFlowId = '91ad451.f6e52b8';

var testNodes = {
  baseTestFlow: JSON.stringify({
    'id': `${testFlowId}`,
    'label': 'Test Flow',
    'nodes': []
  }),
  funnelGrainNode: JSON.stringify({
    'type': 'funnelGrain',
    'z': `${testFlowId}`,
    'name': 'funnel',
    'delay': 0,
    'numPushes': 10,
    'maxBuffer': 10,
    'format': 'video',
    'width': '1920',
    'height': '1080',
    'channels': 2,
    'bitsPerSample': 16,
    'wsPort': `${properties.wsPort}`,
    'x': 100.0,
    'y': 100.0,
    'wires': [[]]
  }),
  funnelCountNode: JSON.stringify({
    'type': 'funnelCount',
    'z': `${testFlowId}`,
    'name': 'funnel',
    'delay': 0,
    'start': 0,
    'end': 1,
    'repeat': false,
    'maxBuffer': 10,
    'wsPort': `${properties.wsPort}`,
    'x': 100.0,
    'y': 100.0,
    'wires': [[]]
  }),
  valveTestNode: JSON.stringify({
    'type': 'valveTest',
    'z': `${testFlowId}`,
    'name': 'valve',
    'maxBuffer': 10,
    'multiplier': 1,
    'x': 300.0,
    'y': 100.0,
    'wires': [[]]
  }),
  spoutTestNode: JSON.stringify({
    'type': 'spoutTest',
    'z': `${testFlowId}`,
    'name': 'spout',
    'timeout':0,
    'x':500.0,
    'y':100.0,
    'wires':[[]]
  })
};

var checkGrain = function(t, obj) {
  var g = new Grain(null, 
    obj.ptpSyncTimestamp, obj.ptpOriginTimestamp, obj.timecode, 
    obj.flow_id, obj.source_id, obj.duration);
  t.equal(obj.hasOwnProperty('payloadCount')?obj.payloadCount:0, 1, 'has single payload');
  t.ok((obj.hasOwnProperty('payloadSize')?obj.payloadSize:0) > 0, 'has payload contents');
  t.ok(g.ptpSync, 'has valid PTP sync timestamp');
  t.ok(g.ptpOrigin, 'has valid PTP origin timestamp');
  t.ok(g.flow_id, 'has valid flow id');
  t.ok(g.source_id, 'has valid source id');
  t.ok(g.duration, 'has valid duration');
  return g;
};

module.exports = {
  nodeRedTest: nodeRedTest,
  properties: properties,
  testNodes: testNodes,
  testFlowId: testFlowId,
  checkGrain: checkGrain
};
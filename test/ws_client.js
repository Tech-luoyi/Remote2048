"use strict";

var WebSocket = require("ws");

module.exports = function client(url, options) {
  var socket = new WebSocket(url, options);
  var inbox = [];
  var waiters = [];
  socket.on("message", function (data) {
    var message = JSON.parse(data.toString());
    var index = waiters.findIndex(function (waiter) { return waiter.predicate(message); });
    if (index < 0) inbox.push(message);
    else {
      var waiter = waiters.splice(index, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  return new Promise(function (resolve, reject) {
    socket.once("error", reject);
    socket.once("open", function () {
      socket.removeListener("error", reject);
      socket.on("error", function () {});
      resolve({
        socket: socket,
        send: function (type, fields) {
          socket.send(JSON.stringify(Object.assign({ type: type, protocolVersion: 1 }, fields)));
          return true;
        },
        next: function (type, predicate) {
          var matches = function (message) { return message.type === type && (!predicate || predicate(message)); };
          var index = inbox.findIndex(matches);
          if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
          return new Promise(function (resolveNext, rejectNext) {
            var waiter = { predicate: matches, resolve: resolveNext };
            waiter.timer = setTimeout(function () {
              waiters.splice(waiters.indexOf(waiter), 1);
              rejectNext(new Error("等待消息超时：" + type));
            }, 2000);
            waiters.push(waiter);
          });
        },
        close: function () {
          if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
          return new Promise(function (resolveClose) {
            socket.once("close", resolveClose);
            socket.close();
          });
        }
      });
    });
  });
};

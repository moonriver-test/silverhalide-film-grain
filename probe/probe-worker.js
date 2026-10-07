/* 探针用的最小 Worker：只回一个消息，用来确认 UXP 是否支持 Worker */
self.onmessage = function (e) {
  var n = 0;
  for (var i = 0; i < 200000; i++) n += Math.sqrt(i);
  self.postMessage({ ok: true, echo: e.data, sum: n });
};

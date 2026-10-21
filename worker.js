/* Pinned Pyodide runtime; graph computation stays off the UI thread. */
let engine, pyodide;
const ready = (async () => {
  postMessage({status: 'Loading Python for your browser…'});
  importScripts('https://cdn.jsdelivr.net/pyodide/v0.27.7/full/pyodide.js');
  pyodide = await loadPyodide({indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/'});
  postMessage({status: 'Loading NumPy and NetworkX…'});
  await pyodide.loadPackage(['numpy', 'networkx']);
  const response = await fetch('engine.py');
  if (!response.ok) throw new Error('Could not load the graph engine.');
  await pyodide.runPythonAsync(await response.text());
  engine = pyodide.runPython('Engine()');
  postMessage({ready: true});
})();
ready.catch(error => postMessage({fatal: `Python could not load. Check your internet connection and reload. ${error.message}`}));
let queue = Promise.resolve();
self.onmessage = ({data: {id, request}}) => {
  queue = queue.then(async () => {
    try {
      await ready;
      if (request.action === 'plot') {
        postMessage({status: 'Preparing the Matplotlib view…'});
        await pyodide.loadPackage('matplotlib');
      }
      const result = JSON.parse(engine.json(JSON.stringify(request)));
      postMessage({id, result});
    } catch (error) {
      postMessage({id, result: {ok: false, error: error.message}});
    }
  });
};

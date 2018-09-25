const Go = require('./Go');

const go = new Go(`${__dirname}/main.wasm`);

go.run(20);
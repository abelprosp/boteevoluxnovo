const PORT = Number(process.env.PORT || 3000);
require("dotenv").config();
const app = require("./app");

app.listen(PORT, () => {
  console.log(`API rodando na porta ${PORT}`);
});

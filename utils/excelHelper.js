// const XLSX = require("xlsx");
// const readExcelFile = (filePath) => {
//   const workbook = XLSX.readFile(filePath);
//   const sheetName = workbook.SheetNames[0];
//   const sheet = workbook.Sheets[sheetName];
//   return XLSX.utils.sheet_to_json(sheet, {
//     defval: "",
//   });
// };

// module.exports = readExcelFile;




// utils/readExcelFile.js
// const XLSX = require("xlsx");
// const readExcelFile = (input) => {
//   const workbook = XLSX.read(input, { type: Buffer.isBuffer(input) ? "buffer" : "file" });
//   const sheet = workbook.Sheets[workbook.SheetNames[0]];
//   return XLSX.utils.sheet_to_json(sheet);
// };

// module.exports = readExcelFile;





const XLSX = require("xlsx");

const readExcelFile = (input) => {
  const workbook = Buffer.isBuffer(input)
    ? XLSX.read(input, { type: "buffer" })   // ✅ Buffer input
    : XLSX.readFile(input);                   // ✅ File path input

  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  
  return XLSX.utils.sheet_to_json(sheet, { defval: "" }); // ✅ prevents undefined cells
};

module.exports = readExcelFile;
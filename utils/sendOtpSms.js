const sendOtpSms = async (phone, otp) => {
  // TODO: Integrate actual SMS provider here
  console.log(`OTP for ${phone}: ${otp}`);

  return true;
};

module.exports = sendOtpSms;
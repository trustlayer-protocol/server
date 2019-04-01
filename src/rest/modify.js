const express = require('express');
const url = require('url');
const { validateParams } = require('../utils/validator');
const { validateUser: validateWithLinkedIn } = require('../requests/linkedin');
const {
  validateUser: validateWithGoogle,
} = require('../requests/google');
const {
  checkAndCreateUser,
} = require('../utils/generators');
const adoption = require('../actions/adoption');
const revocation = require('../actions/revocation');
const getPdf = require('../actions/get-agreement-pdf');
const { generateToken } = require('../security/jwt');


const { InvalidArgumentError } = require('../utils/errors');
const { ACTION } = require('../utils/enums');

const BASE_REDIRECT = process.env.NODE_ENV === 'production'
  ? 'https://trustlayer.trustbot.io' : 'http://localhost:3000';


const router = express.Router();


const completeAction = async (user, stateObject) => {
  let actionResult;
  const { action, link } = stateObject;
  if (action === ACTION.ADOPT) {
    actionResult = await adoption(stateObject, user);
  } else if (action === ACTION.REVOKE) {
    actionResult = await revocation(stateObject, user);
  } else if (action === ACTION.PDF) {
    actionResult = await getPdf(link, user.email);
  } else if (action === ACTION.LOGIN) {
    const token = generateToken(user.id);
    actionResult = { token };
  }

  return actionResult;
};


const parseStateParam = (state) => {
  const stateObject = JSON.parse(state);
  const { action, link, form_id: formId } = stateObject;

  if (!action || (action !== ACTION.LOGIN && (!link && !formId))) {
    throw new InvalidArgumentError('\'state\' param does not have \'action\' or \'link\' or \'form_id\' properties');
  }

  return stateObject;
};


const getRemoteIpAddress = (req) => {
  let ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  if (ip === '::1') {
    ip = '127.0.0.1';
  }

  return ip;
};

const getStateObject = (req, state) => {
  const ip = getRemoteIpAddress(req);
  const stateObject = parseStateParam(state);
  stateObject.ip = ip;

  return stateObject;
};


const processRequest = (promise, code, stateObject, res, next) => promise(code, stateObject)
  .then((result) => {
    const { action } = stateObject;
    if (action === ACTION.PDF) {
      res.contentType('application/pdf');
      return res.end(result.Body, 'binary');
    }
    const redirectUrl = url.format({
      query: result,
    });
    if (action === ACTION.LOGIN) {
      return res.redirect(`${BASE_REDIRECT}/home${redirectUrl}`);
    }
    return res.redirect(`${BASE_REDIRECT}/sso-success${redirectUrl}`);
  })
  .catch((err) => {
    next(err);
  });


const linkedInRequest = async (code, stateObject) => {
  const validationResult = await validateWithLinkedIn(code);
  const { email, profile } = validationResult;


  const user = await checkAndCreateUser(email, profile);
  const { link: userLink } = user;

  const resultAction = await completeAction(user, stateObject);
  return {
    ...resultAction,
    email,
    profile,
    userLink,
  };
};


router.get('/linkedin', (req, res, next) => validateParams(req, next, 'state'),
  (req, res, next) => {
    const { code, state, error } = req.query;
    if (error) {
      return res.redirect(`${BASE_REDIRECT}/sso-fail?message=${error}`);
    }

    const stateObject = getStateObject(req, state);
    return processRequest(linkedInRequest, code, stateObject, res, next);
  });


const googleRequest = async (code, stateObject) => {
  const validationResult = await validateWithGoogle(code);
  const { email, profile } = validationResult;
  const user = await checkAndCreateUser(email, profile);
  const { link: userLink } = user;

  const resultAction = await completeAction(user, stateObject);
  return {
    ...resultAction,
    email,
    profile,
    userLink,
  };
};


router.get('/google', (req, res, next) => validateParams(req, next, 'code', 'state'),
  (req, res, next) => {
    const { code, state } = req.query;

    const stateObject = getStateObject(req, state);

    processRequest(googleRequest, code, stateObject, res, next);
  });

module.exports = router;

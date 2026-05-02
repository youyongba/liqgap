'use strict';

const express = require('express');
const axios = require('axios');

const router = express.Router();

const getAiApiUrl = () => process.env.AITRADE_API_URL || 'https://aitrade.24os.cn';

// 1. 接收交易信号 (POST)
router.post('/signals', async (req, res) => {
  try {
    const url = `${getAiApiUrl()}/api/v1/signals`;
    const response = await axios.post(url, req.body, {
      headers: { 'Content-Type': 'application/json' }
    });
    res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response ? err.response.status : 500;
    const data = err.response ? err.response.data : { error: err.message };
    res.status(status).json(data);
  }
});

// 2. 增量补充数据 (PATCH)
router.patch('/signals/:id?', async (req, res) => {
  try {
    const idPath = req.params.id ? `/${req.params.id}` : '';
    const url = `${getAiApiUrl()}/api/v1/signals${idPath}`;
    const response = await axios.patch(url, req.body, {
      headers: { 'Content-Type': 'application/json' }
    });
    res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response ? err.response.status : 500;
    const data = err.response ? err.response.data : { error: err.message };
    res.status(status).json(data);
  }
});

// 3. 获取信号列表 (GET)
router.get('/signals', async (req, res) => {
  try {
    const url = `${getAiApiUrl()}/api/v1/signals`;
    const response = await axios.get(url, { params: req.query });
    res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response ? err.response.status : 500;
    const data = err.response ? err.response.data : { error: err.message };
    res.status(status).json(data);
  }
});

// 4. 获取信号详情与分析报告 (GET)
router.get('/signals/:id', async (req, res) => {
  try {
    const url = `${getAiApiUrl()}/api/v1/signals/${req.params.id}`;
    const response = await axios.get(url);
    res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response ? err.response.status : 500;
    const data = err.response ? err.response.data : { error: err.message };
    res.status(status).json(data);
  }
});

module.exports = router;
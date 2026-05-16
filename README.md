# YouTube Clone

A full-featured YouTube clone application built with JavaScript and modern web technologies.

## Features

- Video upload and playback
- User authentication
- Comments system
- Like/Subscribe functionality
- Search functionality
- Video recommendations
- Playlist creation
- Watch history
- Responsive design
- Real-time notifications

## Installation

```bash
git clone https://github.com/S-Vetrivel/Youtube_Clone.git
cd Youtube_Clone
npm install
```

## Configuration

Create `.env`:

```
REACT_APP_API_URL=http://localhost:5000/api
FIREBASE_API_KEY=your_firebase_key
YOUTUBE_API_KEY=your_youtube_api_key
```

## Running

```bash
npm start
```

## Technologies

- React
- Node.js/Express
- MongoDB
- Firebase Auth
- Multer (video upload)
- Socket.io (real-time updates)

## Project Structure

```
src/
├── components/
├── pages/
├── services/
├── context/
└── utils/
```

## Features

- Video streaming
- User profiles
- Comments and replies
- Notifications
- Recommendations algorithm
- Search and filters

## Backend API

- `POST /api/videos` - Upload video
- `GET /api/videos/:id` - Get video
- `POST /api/comments` - Add comment
- `POST /api/likes` - Like video
- `POST /api/subscribe` - Subscribe channel

## Deployment

```bash
npm run build
npm run deploy
```

## Contributing

Pull requests welcome!

## License

MIT License

import json
from pathlib import Path
import time
from flask import Flask, request, render_template, jsonify, Response, stream_with_context
from convert import convert_images
from enums import OutputImageFormat
from convert import global_conversion_progress

app = Flask(__name__)

@app.route('/', methods=['GET'])
def index():
    return render_template('index.html')

@app.route('/progress')
def progress_stream():
    def generate():
        while True:
            yield f"data: {json.dumps(global_conversion_progress)}\n\n"
            time.sleep(1) 
    return Response(stream_with_context(generate()), mimetype='text/event-stream')

@app.route('/convert', methods=['POST'])
def convert():
    def validate_and_convert():
        try:
            # Extract data from form submission
            source_folder = request.form['source_folder']
            quality = request.form.get('quality', '80')
            threads = request.form.get('threads', '16')

            # Validate and convert data types
            if not quality.isdigit() or not threads.isdigit():
                raise ValueError("Quality and threads should be numeric values")
            
            quality = int(quality)
            threads = int(threads)

            # Validate input ranges
            if not (0 <= quality <= 100):
                return "Quality must be between 0 and 100", 400
            if threads < 1:
                return "Threads must be at least 1", 400

            # Convert Path strings to Path objects
            source_folder_path = Path(source_folder)
            if not source_folder_path.exists() or not source_folder_path.is_dir():
                return "Source folder is not valid", 400

            # Call your conversion function
            convert_images(source_folder_path, quality, threads, OutputImageFormat.WEBP)
            return "Conversion completed", 200
        except KeyError as e:
            # Handle missing form fields
            return f"Missing form field: {e}", 400
        except ValueError as e:
            # Handle incorrect data types
            return f"Invalid input: {e}", 400
        except Exception as e:
            # Handle any other exceptions
            return f"An error occurred: {e}", 500

    message, status_code = validate_and_convert()
    return jsonify({"message": message}), status_code

if __name__ == '__main__':
    app.run(debug=True)  # Set debug=False in a production environment

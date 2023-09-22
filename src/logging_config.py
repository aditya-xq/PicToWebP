import logging

# Define the log level, format, and the name of the log file
LOG_LEVEL = logging.INFO
LOG_FORMAT = '%(asctime)s - %(levelname)s - %(name)s - %(message)s'
LOG_FILE = 'project_logs.log'

def setup_logging():
    """
    Set up logging configuration for the project.
    Logs will be written to both the console and a log file.
    """
    # Create a logger
    logger = logging.getLogger()
    logger.setLevel(LOG_LEVEL)

    # Create a console handler and set the level to debug
    console_handler = logging.StreamHandler()
    console_handler.setLevel(logging.DEBUG)

    # Create a file handler and set the level to debug
    file_handler = logging.FileHandler(LOG_FILE)
    file_handler.setLevel(LOG_LEVEL)

    # Create a formatter and set it for the handlers
    formatter = logging.Formatter(LOG_FORMAT)
    console_handler.setFormatter(formatter)
    file_handler.setFormatter(formatter)

    # Add the handlers to the logger
    logger.addHandler(console_handler)
    logger.addHandler(file_handler)
